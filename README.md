# Woran

Cloudflare Worker + GitHub Actions Flutter APK Builder.

## Architecture

Telegram Bot
    ↓
Cloudflare Worker
    ↓
GitHub Actions
    ↓
Flutter Build
    ↓
APK Artifact
    ↓
Cloudflare Worker
    ↓
Telegram Bot

## GitHub Actions

Workflow:

.github/workflows/build-flutter.yml

Workflow name:

Flutter Build Worker

Trigger:

workflow_dispatch

Inputs:

- jobId
- userId
- payload

Example payload:

{
  "mode": "zip",
  "url": "https://example.com/flutter-project.zip",
  "buildType": "release"
}

## Cloudflare Secrets

Required:

GITHUB_TOKEN
WORKER_API_KEY

## Cloudflare Variables

GITHUB_OWNER
GITHUB_REPO
GITHUB_WORKFLOW
GITHUB_REF

## Build modes

debug
profile
release

## Flutter ZIP requirements

The ZIP must contain:

pubspec.yaml

The workflow automatically searches for pubspec.yaml.

## Important

Do not commit:

- GitHub tokens
- Telegram bot tokens
- API keys
- passwords
- .env files
