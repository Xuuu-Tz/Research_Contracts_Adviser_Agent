import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());
app.use(express.json({ limit: "25mb" }));
app.use(express.static(__dirname));

function cleanJsonFromModel(raw) {
  if (!raw) return raw;

  let text = raw.trim();

  // In case the model wraps JSON in ```json ... ```
  text = text.replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/```$/i, "").trim();

  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");

  if (start !== -1 && end !== -1 && end > start) {
    text = text.slice(start, end + 1);
  }

  return text;
}

function parseModelJson(raw, errorMessage) {
  const cleaned = cleanJsonFromModel(raw);

  try {
    return JSON.parse(cleaned);
  } catch {
    const error = new Error(errorMessage);
    error.raw = raw;
    throw error;
  }
}

function getAzureOpenAIConfig() {
  const endpoint = process.env.AZURE_OPENAI_ENDPOINT;
  const deployment = process.env.AZURE_OPENAI_DEPLOYMENT;
  const apiVersion = process.env.AZURE_OPENAI_API_VERSION;
  const apiKey = process.env.AZURE_OPENAI_API_KEY;

  if (!endpoint || !deployment || !apiVersion || !apiKey) {
    throw new Error("Missing Azure OpenAI environment variables. Check your .env file.");
  }

  const baseEndpoint = endpoint.replace(/\/+$/, "");
  const url =
    `${baseEndpoint}/openai/deployments/${deployment}/chat/completions?api-version=${apiVersion}`;

  return { apiKey, url };
}

async function callAzureJsonChat({ messages, temperature = 0.2, maxTokens = 2000 }) {
  const { apiKey, url } = getAzureOpenAIConfig();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60000);

  try {
    const response = await fetch(url, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        "api-key": apiKey
      },
      body: JSON.stringify({
        messages,
        temperature,
        max_tokens: maxTokens,
        response_format: { type: "json_object" }
      })
    });

    const data = await response.json();

    if (!response.ok) {
      const error = new Error(data.error?.message || "Azure OpenAI request failed.");
      error.status = response.status;
      error.details = data;
      throw error;
    }

    return data.choices?.[0]?.message?.content;
  } finally {
    clearTimeout(timeout);
  }
}

function contractExcerpt(contractText, maxChars = 14000) {
  return contractText.length > maxChars
    ? `${contractText.slice(0, maxChars)}\n\n[Document excerpt truncated for this step.]`
    : contractText;
}

async function classifyContractType(contractText) {
  const systemPrompt = `
You are a research contract intake classifier for the University of Auckland Research Grants and Contracts team.

Your only task is to classify the contract type. Do not review risks. Do not provide legal advice.

Choose exactly one primaryType from this list:
- Public Research Contract
- Commercial Research Contract
- Subcontract
- Material Transfer Agreement
- Data Transfer Agreement
- Collaboration Agreement
- Confidential Disclosure Agreement
- Hybrid or unclear

Use clause signals, not the file name. Look for:
- Material Transfer Agreement: materials, samples, provider/recipient, permitted use, return or destruction of materials.
- Data Transfer Agreement: datasets, personal information, data controller/processor, privacy, permitted data use, cross-border transfer.
- Confidential Disclosure Agreement: confidential information, disclosure, recipient, non-use, non-disclosure, evaluation purpose.
- Subcontract: prime agreement, flow-down terms, subcontractor, sponsor terms, work package under a main award.
- Collaboration Agreement: joint research, shared responsibilities, steering committee, joint governance, shared outputs.
- Commercial Research Contract: sponsor-funded research, deliverables, milestones, commercial rights, publication controls.
- Public Research Contract: grant/funder terms, public funding, research outputs, institutional reporting obligations.

Return ONLY valid JSON. Do not use markdown.

Use this exact structure:
{
  "primaryType": "Material Transfer Agreement",
  "confidence": 0.86,
  "secondaryTypes": ["Collaboration Agreement"],
  "evidence": [
    "Short reason based on a clause signal"
  ],
  "needsHumanConfirmation": false
}
`;

  const raw = await callAzureJsonChat({
    messages: [
      { role: "system", content: systemPrompt },
      {
        role: "user",
        content: `
Classify this contract:

${contractExcerpt(contractText)}
`
      }
    ],
    temperature: 0,
    maxTokens: 900
  });

  const parsed = parseModelJson(raw, "Model did not return valid contract classification JSON.");
  const allowedTypes = new Set([
    "Public Research Contract",
    "Commercial Research Contract",
    "Subcontract",
    "Material Transfer Agreement",
    "Data Transfer Agreement",
    "Collaboration Agreement",
    "Confidential Disclosure Agreement",
    "Hybrid or unclear"
  ]);

  if (!allowedTypes.has(parsed.primaryType)) {
    parsed.primaryType = "Hybrid or unclear";
  }

  if (typeof parsed.confidence !== "number") {
    parsed.confidence = 0;
  }

  if (!Array.isArray(parsed.secondaryTypes)) {
    parsed.secondaryTypes = [];
  }

  if (!Array.isArray(parsed.evidence)) {
    parsed.evidence = [];
  }

  parsed.needsHumanConfirmation =
    parsed.needsHumanConfirmation === true ||
    parsed.primaryType === "Hybrid or unclear" ||
    parsed.confidence < 0.7;

  return parsed;
}

async function extractClauses(contractText, contractType) {
  const systemPrompt = `
You are a contract clause inventory extractor for the University of Auckland Research Grants and Contracts team.

Your only task is to identify the contract's top-level clauses.

Rules:
- Count top-level clauses only.
- Do not count subclauses such as 1.1, 1.2, 2.3(a), or paragraph bullets as separate clauses.
- Do not count schedules, appendices, signature blocks, cover pages, tables of contents, party details, recitals, or definitions entries as top-level clauses unless they are explicitly numbered as main clauses.
- Preserve the clause numbering used by the contract, for example "1", "2", "Clause 3", or "section 4".
- If a heading is missing, infer a short descriptive heading from the clause text.
- If the document text extraction appears incomplete, set extractionWarnings.

Return ONLY valid JSON. Do not use markdown.

Use this exact structure:
{
  "clauseCount": 25,
  "clauses": [
    {
      "clauseRef": "1",
      "heading": "Definitions",
      "confidence": 0.95
    }
  ],
  "extractionWarnings": []
}
`;

  const raw = await callAzureJsonChat({
    messages: [
      { role: "system", content: systemPrompt },
      {
        role: "user",
        content: `
Contract type: ${contractType || "Hybrid or unclear"}

Extract the top-level clause inventory from this contract:

${contractText}
`
      }
    ],
    temperature: 0,
    maxTokens: 2200
  });

  const parsed = parseModelJson(raw, "Model did not return valid clause inventory JSON.");

  if (!Array.isArray(parsed.clauses)) {
    parsed.clauses = [];
  }

  parsed.clauses = parsed.clauses
    .filter(clause => clause && typeof clause === "object")
    .map(clause => ({
      clauseRef: String(clause.clauseRef || "").trim() || "Unnumbered",
      heading: String(clause.heading || "Untitled clause").trim(),
      confidence: typeof clause.confidence === "number" ? clause.confidence : 0
    }));

  const numericClauseCount = Number(parsed.clauseCount);
  parsed.clauseCount = Number.isInteger(numericClauseCount) && numericClauseCount >= 0
    ? numericClauseCount
    : parsed.clauses.length;

  if (!Array.isArray(parsed.extractionWarnings)) {
    parsed.extractionWarnings = [];
  }

  return parsed;
}

async function reviewContract(contractText, contractType, clauseInventory) {
  const systemPrompt = `
You are a Research Contract Reviewer Agent for the University of Auckland Research Grants and Contracts team.

You must not provide legal advice.
You must not approve or reject contracts.
All final decisions must remain with human contract managers.

Use the following UoA mock position store:

1. Governing Law
Rule strength: must
Position: The agreement must be governed by New Zealand law unless an approved exception applies.
Green: The contract uses New Zealand law.
Amber: The contract uses another jurisdiction but allows negotiation or review.
Red: The contract requires foreign law or foreign courts without approval.
Blue: No matching position is found.

2. Liability
Rule strength: must
Position: The University's liability must be limited or capped.
Green: The clause includes a clear and reasonable liability cap.
Amber: The clause includes a cap but the amount or wording requires review.
Red: The clause creates unlimited liability for the University.
Blue: The liability structure is unclear or not covered.

3. Intellectual Property
Rule strength: must
Position: The University must retain ownership of its background intellectual property.
Green: The clause protects UoA background IP.
Amber: The other party receives limited rights, but UoA background IP is protected.
Red: The clause gives ownership of UoA background IP to another party.
Blue: The clause introduces a new IP category not covered.

4. Publication
Rule strength: should
Position: Researchers should retain the right to publish research results, subject only to reasonable confidentiality review.
Green: Publication is allowed after a reasonable review period.
Amber: Publication is allowed but requires a longer review period, such as 60 days.
Red: The sponsor or provider can permanently block publication.
Blue: The publication condition is not covered.

5. Confidentiality
Rule strength: should
Position: Confidentiality obligations should be limited and reasonable.
Green: The confidentiality period is limited and reasonable.
Amber: The confidentiality period is long but not unlimited.
Red: The clause creates unlimited confidentiality obligations.
Blue: The confidentiality requirement is not covered.

6. AI-generated Outputs
Rule strength: not_covered
Position: No standard UoA position is currently available.
Blue: Any AI-generated output clause should be escalated for human or legal review.

Flag system:
green = aligns with UoA position.
amber = partially aligns but requires contract manager review.
red = conflicts with UoA position and must be revised.
blue = not covered by UoA positions.

Return ONLY valid JSON. Do not use markdown. Do not wrap the JSON in code fences.

Use this exact structure:
{
  "detectedType": "Material Transfer Agreement",
  "flags": [
    {
      "severity": "green",
      "clauseRef": "Clause 1",
      "title": "Governing Law",
      "snippet": "Short quote from the contract clause",
      "rationale": "Reason for the flag and recommended next step"
    }
  ]
}
`;

  const raw = await callAzureJsonChat({
    messages: [
      { role: "system", content: systemPrompt },
      {
        role: "user",
        content: `
Selected contract type: ${contractType || "Hybrid or unclear"}

Recognised top-level clause inventory:
${JSON.stringify(clauseInventory || { clauseCount: 0, clauses: [] }, null, 2)}

Use clause references from the recognised clause inventory where possible. Do not invent clause numbers.

Please review this contract:

${contractText}
`
      }
    ],
    temperature: 0.2,
    maxTokens: 2500
  });

  const parsed = parseModelJson(raw, "Model did not return valid review JSON.");

  if (!parsed.flags || !Array.isArray(parsed.flags)) {
    const error = new Error("Model JSON did not include a valid flags array.");
    error.raw = parsed;
    throw error;
  }

  parsed.detectedType = contractType || parsed.detectedType || "Hybrid or unclear";

  return parsed;
}

app.post("/api/review-contract", async (req, res) => {
  try {
    const { contractText, contractType } = req.body;

    if (!contractText || typeof contractText !== "string") {
      return res.status(400).json({ error: "contractText is required." });
    }

    let finalContractType = contractType;
    let classification = null;

    if (!finalContractType || finalContractType === "auto") {
      classification = await classifyContractType(contractText);
      finalContractType = classification.primaryType;
    }

    const clauseInventory = await extractClauses(contractText, finalContractType);
    const review = await reviewContract(contractText, finalContractType, clauseInventory);

    if (classification) {
      review.classification = classification;
    }

    review.clauseInventory = clauseInventory;

    res.json(review);
  } catch (error) {
    const message =
      error.name === "AbortError"
        ? "Azure OpenAI request timed out."
        : error.message || "Server error.";

    res.status(error.status || 500).json({
      error: message,
      details: error.details,
      raw: error.raw
    });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Backend running at http://localhost:${PORT}`);
});
