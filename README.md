# Research Contracts Adviser Agent

This is a local demo app for reviewing research contracts. It provides a browser-based interface for uploading or pasting contract text, extracts text from common document formats, and sends the contract content to an Azure OpenAI deployment for contract classification, clause extraction, and risk flagging.

## Features

- Review pasted contract text or uploaded files.
- Supports `.txt` files.
- Supports `.docx` extraction in the browser with Mammoth.js.
- Supports text-based `.pdf` extraction in the browser with PDF.js.
- Supports scanned or image-based PDFs with a Tesseract.js OCR fallback.
- Uses a local Express backend to call Azure OpenAI securely.

## Requirements

- Node.js 18 or newer.
- npm.
- An Azure OpenAI resource with:
  - Endpoint.
  - Deployment name.
  - API version.
  - API key.
- Optional: an Azure AI Foundry Agent with file search enabled and the UoA standard templates uploaded to its knowledge base.

## Setup

Install dependencies from the project root:

```bash
npm install
```

Create a local environment file:

```bash
cp .env.example .env
```

Then open `.env` and fill in the Azure OpenAI values:

```bash
AZURE_OPENAI_ENDPOINT=https://your-resource.openai.azure.com/
AZURE_OPENAI_DEPLOYMENT=your-deployment-name
AZURE_OPENAI_API_VERSION=2024-08-01-preview
AZURE_OPENAI_API_KEY=your-azure-openai-key
```

Do not put real secrets in `.env.example`. The real key should only be stored in `.env`.

## Foundry Knowledge Base

The app can optionally retrieve standard contract templates from an Azure AI Foundry Agent knowledge base before reviewing the uploaded contract.

This is useful when your uploaded knowledge base includes files such as:

```text
UoA-CDA Two Way Template.docx
UoA-Data Access Agreement Agency Template (incoming) May 2024 (1).docx
UoA-Data Access Agreement Template (outgoing) May 2024.docx
UoA-Data Transfer Agreement Template (incoming) April 2024 .docx
UoA-Data Transfer Agreement Template (outgoing) April 2024.docx
UoA-Material_Transfer_Agreement incoming-Aug 2024.docx
UoA-Material_Transfer_Agreement_outgoing_Aug 2024.docx
UoA-Research Collaboration Agreement Template (1).docx
UoA-Template Subcontractor Agreement_2025 (1) (1).docx
Contracting Positions - Approvals and Escalation Protocol_Final_Sept_25.pdf
```

To enable retrieval, add these values to `.env`:

```bash
FOUNDRY_PROJECT_ENDPOINT=https://your-foundry-resource.services.ai.azure.com/api/projects/your-project
FOUNDRY_AGENT_NAME=your-agent-name
FOUNDRY_AGENT_TOKEN=your-foundry-token
FOUNDRY_KNOWLEDGE_REQUIRED=false
```

Get a temporary Foundry token with Azure CLI:

```bash
az account get-access-token --scope "https://ai.azure.com/.default" --query accessToken -o tsv
```

Paste the token into `FOUNDRY_AGENT_TOKEN`, then restart the server. These tokens expire, so refresh the token if Foundry retrieval starts returning authentication errors.

If `FOUNDRY_KNOWLEDGE_REQUIRED=false`, the app falls back to the built-in prompt and mock position store when Foundry retrieval is not configured or fails. If set to `true`, the review fails fast when the knowledge base cannot be used.

## Run

Start the backend and static frontend server:

```bash
npm start
```

When the server starts successfully, it should print:

```bash
Backend running at http://localhost:3000
```

Open the app in your browser:

```text
http://localhost:3000
```

## Project Structure

```text
.
|-- .env.example
|-- .gitignore
|-- README.md
|-- index.html
|-- package-lock.json
|-- package.json
`-- server.js
```

## Important Notes

- `server.js` reads environment variables from `.env` with `dotenv`.
- `index.html` is served by the Express static file middleware.
- The frontend calls the backend endpoint at `/api/review-contract`.
- The backend classifies the contract, extracts clauses, optionally retrieves matching Foundry knowledge base context, and then calls Azure OpenAI for the review.
- The browser never needs direct access to the API key or Foundry token.
- OCR for scanned PDFs runs in the browser and may be slow. For demos, use short scanned PDFs when possible.

## Troubleshooting

### `Cannot GET /`

The server is running, but static file serving is not configured or the app has not been restarted after code changes. Stop the server with `Ctrl + C`, then run:

```bash
npm start
```

### `Missing Azure OpenAI environment variables`

The backend cannot find one or more required variables. Check that:

- `.env` exists in the project root.
- The variable names match `.env.example`.
- The API key is in `.env`, not only in `.env.example`.
- The server was restarted after editing `.env`.

### Azure request returns 401, 403, or 404

Check that:

- The key is an Azure OpenAI key, not a standard OpenAI platform key.
- The endpoint matches the Azure resource that owns the key.
- The deployment name is correct.
- The API version is supported by the Azure OpenAI resource.

### Foundry knowledge base retrieval is skipped

Check that:

- `FOUNDRY_PROJECT_ENDPOINT` points to the Foundry project endpoint, not only the Azure OpenAI resource endpoint.
- `FOUNDRY_AGENT_NAME` matches the agent that has file search enabled.
- `FOUNDRY_AGENT_TOKEN` is present and has not expired.
- The server was restarted after editing `.env`.

## Security

- Do not commit `.env`.
- Do not share API keys in screenshots, README files, commits, or chat logs.
- Keep `.env.example` as a template only.
