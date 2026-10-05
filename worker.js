const GITHUB_API = "https://api.github.com";

export default {
  async fetch(request, env) {
    try {
      const url = new URL(request.url);

      // =========================
      // CORS
      // =========================
      if (request.method === "OPTIONS") {
        return new Response(null, {
          status: 204,
          headers: corsHeaders(),
        });
      }

      // =========================
      // HEALTH
      // =========================
      if (url.pathname === "/health" && request.method === "GET") {
        return json({
          ok: true,
          service: "woran",
          time: new Date().toISOString(),
        });
      }

      // Semua endpoint selain /health wajib API key
      if (!authorized(request, env)) {
        return json(
          {
            ok: false,
            error: "Unauthorized",
          },
          401
        );
      }

      // =========================
      // BUILD
      // =========================
      if (url.pathname === "/build" && request.method === "POST") {
        return await startBuild(request, env);
      }

      // =========================
      // STATUS
      // =========================
      const statusMatch = url.pathname.match(
        /^\/status\/(\d+)$/
      );

      if (statusMatch && request.method === "GET") {
        return await getStatus(
          statusMatch[1],
          env
        );
      }

      // =========================
      // ARTIFACT
      // =========================
      const artifactMatch = url.pathname.match(
        /^\/artifact\/(\d+)$/
      );

      if (artifactMatch && request.method === "GET") {
        return await getArtifact(
          artifactMatch[1],
          env
        );
      }

      return json(
        {
          ok: false,
          error: "Not found",
        },
        404
      );
    } catch (error) {
      console.error(error);

      return json(
        {
          ok: false,
          error: error?.message || "Internal Server Error",
        },
        500
      );
    }
  },
};


// ============================================================
// AUTH
// ============================================================

function authorized(request, env) {
  const expected = env.WORKER_API_KEY;

  if (!expected) {
    return false;
  }

  const header = request.headers.get("Authorization");

  if (!header) {
    return false;
  }

  const prefix = "Bearer ";

  if (!header.startsWith(prefix)) {
    return false;
  }

  const token = header.slice(prefix.length).trim();

  return token === expected;
}


// ============================================================
// START BUILD
// ============================================================

async function startBuild(request, env) {
  if (!env.GITHUB_TOKEN) {
    return json(
      {
        ok: false,
        error: "GITHUB_TOKEN belum diset di Cloudflare",
      },
      500
    );
  }

  const body = await request.json();

  const jobId =
    String(body.jobId || "").trim();

  const userId =
    String(body.userId || "").trim();

  const sourceUrl =
    String(body.url || "").trim();

  const buildType =
    String(body.buildType || "release")
      .toLowerCase();

  if (!jobId) {
    return json(
      {
        ok: false,
        error: "jobId wajib diisi",
      },
      400
    );
  }

  if (!userId) {
    return json(
      {
        ok: false,
        error: "userId wajib diisi",
      },
      400
    );
  }

  if (!sourceUrl) {
    return json(
      {
        ok: false,
        error: "url wajib diisi",
      },
      400
    );
  }

  // Hanya HTTPS
  if (!sourceUrl.startsWith("https://")) {
    return json(
      {
        ok: false,
        error: "URL source harus HTTPS",
      },
      400
    );
  }

  // Source ZIP harus dari host yang diizinkan
  const source = new URL(sourceUrl);

  const allowedHosts = [
    "github.com",
    "raw.githubusercontent.com",
    "objects.githubusercontent.com",
    "codeload.github.com",
    "release-assets.githubusercontent.com",
  ];

  if (!allowedHosts.includes(source.hostname)) {
    return json(
      {
        ok: false,
        error:
          "Source URL harus berasal dari GitHub",
      },
      400
    );
  }

  if (
    !["debug", "profile", "release"]
      .includes(buildType)
  ) {
    return json(
      {
        ok: false,
        error:
          "buildType harus debug, profile, atau release",
      },
      400
    );
  }

  const payload = {
    mode: body.mode || "zip",
    url: sourceUrl,
    buildType,
    tag: body.tag || "",
    appName: body.appName || "",
    iconUrl: body.iconUrl || "",
  };

  const owner =
    env.GITHUB_OWNER;

  const repo =
    env.GITHUB_REPO;

  const workflow =
    env.GITHUB_WORKFLOW ||
    "build-flutter.yml";

  const ref =
    env.GITHUB_REF ||
    "main";

  if (!owner || !repo) {
    return json(
      {
        ok: false,
        error:
          "GITHUB_OWNER / GITHUB_REPO belum dikonfigurasi",
      },
      500
    );
  }

  const dispatchTime =
    Date.now();

  // ==========================================================
  // GITHUB WORKFLOW DISPATCH
  // ==========================================================

  const dispatchUrl =
    `${GITHUB_API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions/workflows/${encodeURIComponent(workflow)}/dispatches`;

  const dispatchResponse =
    await githubFetch(
      dispatchUrl,
      env.GITHUB_TOKEN,
      {
        method: "POST",
        body: JSON.stringify({
          ref,
          inputs: {
            jobId,
            userId,
            payload: JSON.stringify(payload),
          },
        }),
      }
    );

  if (!dispatchResponse.ok) {
    const errorText =
      await safeText(dispatchResponse);

    return json(
      {
        ok: false,
        error:
          "Gagal menjalankan GitHub Actions",
        githubStatus:
          dispatchResponse.status,
        details: errorText,
      },
      502
    );
  }

  // GitHub dapat mengembalikan 204 tanpa run ID.
  // Karena itu kita cari run berdasarkan jobId.
  const run =
    await findWorkflowRun(
      env,
      owner,
      repo,
      workflow,
      ref,
      jobId,
      dispatchTime
    );

  if (!run) {
    return json(
      {
        ok: true,
        queued: true,
        jobId,
        message:
          "GitHub Actions berhasil dipanggil, tetapi run ID belum tersedia. Coba cek status lagi.",
      }
    );
  }

  return json({
    ok: true,
    queued: true,
    jobId,
    userId,
    runId: run.id,
    runUrl: run.html_url,
    status: run.status,
    conclusion: run.conclusion,
    artifactName: `apk-${jobId}`,
  });
}


// ============================================================
// FIND WORKFLOW RUN
// ============================================================

async function findWorkflowRun(
  env,
  owner,
  repo,
  workflow,
  ref,
  jobId,
  dispatchTime
) {
  const endpoint =
    `${GITHUB_API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions/workflows/${encodeURIComponent(workflow)}/runs?event=workflow_dispatch&branch=${encodeURIComponent(ref)}&per_page=20`;

  // Tunggu sebentar agar GitHub membuat run
  for (let attempt = 0; attempt < 10; attempt++) {
    const response =
      await githubFetch(
        endpoint,
        env.GITHUB_TOKEN
      );

    if (response.ok) {
      const data =
        await response.json();

      const runs =
        data.workflow_runs || [];

      const found =
        runs.find((run) => {
          const created =
            new Date(
              run.created_at
            ).getTime();

          const name =
            String(
              run.display_title ||
              run.name ||
              ""
            );

          return (
            created >= dispatchTime - 10000 &&
            (
              name.includes(jobId) ||
              run.event === "workflow_dispatch"
            )
          );
        });

      if (found) {
        return found;
      }
    }

    await sleep(1500);
  }

  return null;
}


// ============================================================
// GET STATUS
// ============================================================

async function getStatus(runId, env) {
  const owner =
    env.GITHUB_OWNER;

  const repo =
    env.GITHUB_REPO;

  const endpoint =
    `${GITHUB_API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions/runs/${runId}`;

  const response =
    await githubFetch(
      endpoint,
      env.GITHUB_TOKEN
    );

  const data =
    await safeJson(response);

  if (!response.ok) {
    return json(
      {
        ok: false,
        error:
          "Gagal mengambil status GitHub Actions",
        githubStatus:
          response.status,
        details: data,
      },
      502
    );
  }

  return json({
    ok: true,
    runId: data.id,
    status: data.status,
    conclusion: data.conclusion,
    name: data.name,
    displayTitle: data.display_title,
    runUrl: data.html_url,
    createdAt: data.created_at,
    updatedAt: data.updated_at,
  });
}


// ============================================================
// GET ARTIFACT
// ============================================================

async function getArtifact(runId, env) {
  const owner =
    env.GITHUB_OWNER;

  const repo =
    env.GITHUB_REPO;

  const endpoint =
    `${GITHUB_API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions/runs/${runId}/artifacts`;

  const response =
    await githubFetch(
      endpoint,
      env.GITHUB_TOKEN
    );

  if (!response.ok) {
    return json(
      {
        ok: false,
        error:
          "Gagal mengambil daftar artifact",
        githubStatus:
          response.status,
        details:
          await safeText(response),
      },
      502
    );
  }

  const data =
    await response.json();

  const artifacts =
    data.artifacts || [];

  if (!artifacts.length) {
    return json(
      {
        ok: false,
        error:
          "Artifact APK belum tersedia",
      },
      404
    );
  }

  // Ambil artifact pertama yang belum expired
  const artifact =
    artifacts.find(
      (item) => !item.expired
    );

  if (!artifact) {
    return json(
      {
        ok: false,
        error:
          "Artifact sudah expired",
      },
      410
    );
  }

  const downloadUrl =
    `${GITHUB_API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions/artifacts/${artifact.id}/zip`;

  const downloadResponse =
    await githubFetch(
      downloadUrl,
      env.GITHUB_TOKEN,
      {
        redirect: "manual",
      }
    );

  // GitHub biasanya memberikan redirect
  if (
    downloadResponse.status >= 300 &&
    downloadResponse.status < 400
  ) {
    const location =
      downloadResponse.headers.get(
        "Location"
      );

    if (!location) {
      return json(
        {
          ok: false,
          error:
            "GitHub tidak memberikan URL download artifact",
        },
        502
      );
    }

    const fileResponse =
      await fetch(location);

    if (!fileResponse.ok) {
      return json(
        {
          ok: false,
          error:
            "Gagal download artifact",
          status:
            fileResponse.status,
        },
        502
      );
    }

    return new Response(
      fileResponse.body,
      {
        status: 200,
        headers: {
          "Content-Type":
            "application/zip",

          "Content-Disposition":
            `attachment; filename="${artifact.name}.zip"`,

          "Cache-Control":
            "no-store",

          ...corsHeaders(),
        },
      }
    );
  }

  if (!downloadResponse.ok) {
    return json(
      {
        ok: false,
        error:
          "Gagal mengambil artifact",
        githubStatus:
          downloadResponse.status,
      },
      502
    );
  }

  return new Response(
    downloadResponse.body,
    {
      status: 200,
      headers: {
        "Content-Type":
          "application/zip",

        "Content-Disposition":
          `attachment; filename="${artifact.name}.zip"`,

        "Cache-Control":
          "no-store",

        ...corsHeaders(),
      },
    }
  );
}


// ============================================================
// GITHUB FETCH
// ============================================================

async function githubFetch(
  url,
  token,
  options = {}
) {
  const headers = new Headers(
    options.headers || {}
  );

  headers.set(
    "Authorization",
    `Bearer ${token}`
  );

  headers.set(
    "Accept",
    "application/vnd.github+json"
  );

  headers.set(
    "X-GitHub-Api-Version",
    "2022-11-28"
  );

  headers.set(
    "User-Agent",
    "Woran-Flutter-Worker"
  );

  if (
    options.body &&
    !headers.has("Content-Type")
  ) {
    headers.set(
      "Content-Type",
      "application/json"
    );
  }

  return fetch(url, {
    ...options,
    headers,
  });
}


// ============================================================
// HELPERS
// ============================================================

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers":
      "Authorization, Content-Type",
    "Access-Control-Allow-Methods":
      "GET, POST, OPTIONS",
  };
}

function json(data, status = 200) {
  return new Response(
    JSON.stringify(data, null, 2),
    {
      status,
      headers: {
        "Content-Type":
          "application/json; charset=utf-8",

        "Cache-Control":
          "no-store",

        ...corsHeaders(),
      },
    }
  );
}

async function safeText(response) {
  try {
    return await response.text();
  } catch {
    return "";
  }
}

async function safeJson(response) {
  try {
    return await response.json();
  } catch {
    return {};
  }
}

function sleep(ms) {
  return new Promise(
    (resolve) =>
      setTimeout(resolve, ms)
  );
          }
