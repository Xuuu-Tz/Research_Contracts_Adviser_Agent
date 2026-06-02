import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import { AgentsClient } from "@azure/ai-agents";
import { DefaultAzureCredential } from "@azure/identity";

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
  const url = baseEndpoint.includes("/api/projects/") && baseEndpoint.endsWith("/openai")
    ? `${baseEndpoint}/deployments/${deployment}/chat/completions?api-version=${apiVersion}`
    : `${baseEndpoint}/openai/deployments/${deployment}/chat/completions?api-version=${apiVersion}`;

  return { apiKey, url };
}

async function callAzureJsonChat({ messages, temperature = 0.2, maxTokens = 2000 }) {
  const { apiKey, url } = getAzureOpenAIConfig();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 600000); // 10 minutes

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
    console.log(data)

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

function normalizeClauseRefForMatch(value) {
  const text = String(value || "").toLowerCase().trim();
  if (!text) return "";

  const withoutPrefix = text
    .replace(/^(clause|section|article)\s+/i, "")
    .replace(/^no\.\s+/i, "")
    .trim();
  const numericRef = withoutPrefix.match(/^(\d+(?:\.\d+)*)\b/);

  if (numericRef) {
    return numericRef[1];
  }

  return withoutPrefix.replace(/[^a-z0-9]+/g, " ").trim();
}

function confidenceLabelFromClause(clause) {
  return typeof clause.confidence === "number" && clause.confidence >= 0.8
    ? "Medium"
    : "Low";
}

function buildExpectedClauseCoverage(clauseInventory) {
  const clauses = Array.isArray(clauseInventory?.clauses)
    ? clauseInventory.clauses.map(clause => ({
        clauseRef: String(clause.clauseRef || "").trim() || "Unnumbered",
        heading: String(clause.heading || "Unreviewed Clause").trim(),
        confidence: typeof clause.confidence === "number" ? clause.confidence : 0
      }))
    : [];
  const declaredCount = Number(clauseInventory?.clauseCount);
  const expectedCount = Number.isInteger(declaredCount) && declaredCount > 0
    ? declaredCount
    : clauses.length;

  if (expectedCount > 0 && expectedCount < clauses.length) {
    const numericClauses = clauses.filter(clause => /^\d+$/.test(normalizeClauseRefForMatch(clause.clauseRef)));

    if (numericClauses.length >= Math.ceil(clauses.length * 0.6)) {
      const byRef = new Map();

      for (const clause of numericClauses) {
        const ref = normalizeClauseRefForMatch(clause.clauseRef);
        const refNumber = Number(ref);

        if (!Number.isInteger(refNumber) || refNumber < 1 || refNumber > expectedCount) {
          continue;
        }

        byRef.set(ref, clause);
      }

      const expectedClauses = [];

      for (let index = 1; index <= expectedCount; index++) {
        const ref = String(index);
        expectedClauses.push(
          byRef.get(ref) || {
            clauseRef: ref,
            heading: "Recognised clause missing from clause inventory details",
            confidence: 0
          }
        );
      }

      return expectedClauses;
    }

    return clauses.slice(0, expectedCount);
  }

  if (expectedCount <= clauses.length) {
    return clauses;
  }

  const seenRefs = new Set(clauses.map(clause => normalizeClauseRefForMatch(clause.clauseRef)));
  const hasMostlyNumericRefs =
    clauses.length > 0 &&
    clauses.filter(clause => /^\d+$/.test(normalizeClauseRefForMatch(clause.clauseRef))).length >=
      Math.ceil(clauses.length * 0.6);
  const expectedClauses = [...clauses];

  if (hasMostlyNumericRefs) {
    for (let index = 1; index <= expectedCount && expectedClauses.length < expectedCount; index++) {
      const ref = String(index);

      if (seenRefs.has(ref)) {
        continue;
      }

      expectedClauses.push({
        clauseRef: ref,
        heading: "Recognised clause missing from clause inventory details",
        confidence: 0
      });
      seenRefs.add(ref);
    }
  }

  while (expectedClauses.length < expectedCount) {
    const placeholderNumber = expectedClauses.length + 1;
    expectedClauses.push({
      clauseRef: `Unreviewed clause ${placeholderNumber}`,
      heading: "Recognised clause missing from clause inventory details",
      confidence: 0
    });
  }

  return expectedClauses;
}

function createBlueCoverageFlag(clause) {
  return {
    severity: "blue",
    clauseRef: clause.clauseRef,
    title: clause.heading || "Unreviewed Clause",
    snippet: "No snippet returned by the automated review.",
    matchedPosition: "No model finding returned for this recognised top-level clause.",
    rationale:
      "The automated review did not return a finding for this recognised top-level clause. Treat it as not covered by the current automated analysis and review it manually.",
    requiredEscalation: "Contract Manager review",
    confidence: confidenceLabelFromClause(clause)
  };
}

function compareClauseRefs(a, b) {
  const aRef = normalizeClauseRefForMatch(a.clauseRef);
  const bRef = normalizeClauseRefForMatch(b.clauseRef);
  const aNumber = Number(aRef);
  const bNumber = Number(bRef);

  if (Number.isFinite(aNumber) && Number.isFinite(bNumber)) {
    return aNumber - bNumber;
  }

  return aRef.localeCompare(bRef);
}

function severityPriority(severity) {
  return { red: 4, amber: 3, blue: 2, green: 1 }[String(severity || "").toLowerCase()] || 0;
}

function isPlaceholderSnippet(snippet) {
  const text = String(snippet || "");
  return (
    text.startsWith("No snippet returned") ||
    text.startsWith("No exact clause excerpt") ||
    text === "No snippet available."
  );
}

function flagContentScore(flag) {
  let score = 0;

  if (!isPlaceholderSnippet(flag.snippet)) score += 3;
  if (flag.matchedPosition && flag.matchedPosition !== "Not specified.") score += 2;
  if (flag.rationale && !flag.rationale.includes("No issue identified")) score += 1;
  if (flag.title && flag.title !== "Untitled Clause") score += 1;

  return score;
}

function chooseBestFlag(flags) {
  return [...flags].sort((a, b) => {
    const severityDiff = severityPriority(b.severity) - severityPriority(a.severity);
    if (severityDiff !== 0) return severityDiff;
    return flagContentScore(b) - flagContentScore(a);
  })[0];
}

function addMissingClauseCoverage(result, clauseInventory) {
  const clauses = buildExpectedClauseCoverage(clauseInventory);

  if (clauses.length === 0) {
    result.coverage = {
      recognisedClauseCount: 0,
      reviewedFlagCount: result.flags.length,
      addedBlueFlags: 0,
      droppedExtraFlags: 0,
      mergedDuplicateFlags: 0
    };
    return;
  }

  const expectedByRef = new Map(
    clauses
      .map(clause => [normalizeClauseRefForMatch(clause.clauseRef), clause])
      .filter(([key]) => Boolean(key))
  );
  const flagsByRef = new Map();
  let addedBlueFlags = 0;
  let droppedExtraFlags = 0;
  let mergedDuplicateFlags = 0;

  for (const flag of result.flags) {
    const key = normalizeClauseRefForMatch(flag.clauseRef);

    if (!key || !expectedByRef.has(key)) {
      droppedExtraFlags++;
      continue;
    }

    if (!flagsByRef.has(key)) {
      flagsByRef.set(key, []);
    }

    flagsByRef.get(key).push(flag);
  }

  const alignedFlags = [];

  for (const clause of clauses) {
    const clauseKey = normalizeClauseRefForMatch(clause.clauseRef);
    const flagsForClause = flagsByRef.get(clauseKey) || [];

    if (!clauseKey) {
      continue;
    }

    if (flagsForClause.length === 0) {
      alignedFlags.push(createBlueCoverageFlag(clause));
      addedBlueFlags++;
      continue;
    }

    if (flagsForClause.length > 1) {
      mergedDuplicateFlags += flagsForClause.length - 1;
    }

    const chosenFlag = chooseBestFlag(flagsForClause);
    alignedFlags.push({
      ...chosenFlag,
      clauseRef: clause.clauseRef,
      title:
        chosenFlag.title && chosenFlag.title !== "Untitled Clause"
          ? chosenFlag.title
          : clause.heading || "Untitled Clause"
    });
  }

  result.flags = alignedFlags.sort(compareClauseRefs);

  while (result.flags.length < clauses.length) {
    const placeholderNumber = result.flags.length + 1;

    result.flags.push(createBlueCoverageFlag({
      clauseRef: `Unreviewed clause ${placeholderNumber}`,
      heading: "Recognised clause missing from automated review",
      confidence: 0
    }));
    addedBlueFlags++;
  }

  result.coverage = {
    recognisedClauseCount: clauses.length,
    reviewedFlagCount: result.flags.length,
    addedBlueFlags,
    droppedExtraFlags,
    mergedDuplicateFlags
  };
}

function normalizeReviewResult(result, fallbackType, clauseInventory) {
  if (!result || typeof result !== "object") {
    throw new Error("Invalid JSON result from model.");
  }

  if (!Array.isArray(result.flags)) {
    result.flags = [];
  }

  result.detectedType = fallbackType || result.detectedType || "Other / Unknown";
  result.selectedTemplate = result.selectedTemplate || "Not specified";
  result.knowledgeBaseDocuments = Array.isArray(result.knowledgeBaseDocuments)
    ? result.knowledgeBaseDocuments
    : [];

  result.flags = result.flags.map((flag, index) => {
    const severity = String(flag.severity || "blue").toLowerCase();

    return {
      severity: ["green", "amber", "red", "blue"].includes(severity) ? severity : "blue",
      clauseRef: flag.clauseRef || `Clause ${index + 1}`,
      title: flag.title || "Untitled Clause",
      snippet: flag.snippet || "No snippet available.",
      matchedPosition: flag.matchedPosition || "Not specified.",
      rationale:
        flag.rationale ||
        "Aligns because the clause does not appear to create a concern based on the available knowledge base.",
      requiredEscalation: flag.requiredEscalation || "None",
      confidence: flag.confidence || "Medium"
    };
  });

  addMissingClauseCoverage(result, clauseInventory);

  const counts = { green: 0, amber: 0, red: 0, blue: 0 };

  for (const flag of result.flags) {
    counts[flag.severity]++;
  }

  result.summary = result.summary || {};
  result.summary.greenCount = counts.green;
  result.summary.amberCount = counts.amber;
  result.summary.redCount = counts.red;
  result.summary.blueCount = counts.blue;

  if (counts.red > 0) {
    result.summary.overallRisk = "High";
  } else if (counts.amber > 0 || counts.blue > 0) {
    result.summary.overallRisk = "Medium";
  } else {
    result.summary.overallRisk = "Low";
  }

  if (!Array.isArray(result.summary.keyIssues)) {
    result.summary.keyIssues = counts.red > 0
      ? ["Red flag clauses require escalation before signing."]
      : ["No major issues identified."];
  }

  if (result.coverage?.addedBlueFlags > 0) {
    result.summary.keyIssues.push(
      `${result.coverage.addedBlueFlags} recognised clause(s) were not returned by the model and were marked blue for manual review.`
    );
  }

  result.disclaimer =
    result.disclaimer ||
    "This report is a decision-support tool only and requires review by the RGC Team. It does not constitute legal advice.";

  return result;
}

const TEMPLATE_FILE_HINTS = {
  "Confidential Disclosure Agreement": [
    "UoA-CDA Two Way Template.docx"
  ],
  "Data Access Agreement - Incoming Agency": [
    "UoA-Data Access Agreement Agency Template (incoming) May 2024 (1).docx"
  ],
  "Data Access Agreement - Outgoing": [
    "UoA-Data Access Agreement Template (outgoing) May 2024.docx"
  ],
  "Data Transfer Agreement - Incoming": [
    "UoA-Data Transfer Agreement Template (incoming) April 2024 .docx"
  ],
  "Data Transfer Agreement - Outgoing": [
    "UoA-Data Transfer Agreement Template (outgoing) April 2024.docx"
  ],
  "Material Transfer Agreement - Outbound Key Materials": [
    "UoA-MTA_Outbound for Key Materials-April 2018.docx"
  ],
  "Master Services Agreement": [
    "UoA-Master Services Agreement Template (1).docx"
  ],
  "Material Transfer Agreement - Incoming": [
    "UoA-Material_Transfer_Agreement incoming-Aug 2024.docx"
  ],
  "Material Transfer Agreement - Outgoing": [
    "UoA-Material_Transfer_Agreement_outgoing_Aug 2024.docx"
  ],
  "Provision of Services Agreement - Agency": [
    "UoA-Provision of Services Agreement (Agency)_June 2024.docx"
  ],
  "Research Collaboration Agreement": [
    "UoA-Research Collaboration Agreement Template (1).docx"
  ],
  "Research Services Agreement - Agency": [
    "UoA-Research Services Agreement (Agency) _June 2024 .docx"
  ],
  "Student Research Agreement": [
    "UoA-Student Research Agreement Template (April 2018).docx"
  ],
  "Subcontractor Agreement": [
    "UoA-Template Subcontractor Agreement_2025 (1) (1).docx"
  ]
};

const POLICY_FILE_HINTS = [
  "Contracting Positions - Approvals and Escalation Protocol_Final_Sept_25.pdf",
  "Research_Contracts_Adviser_Agent.pdf"
];

function normalizeFoundryProjectEndpoint(endpoint) {
  let baseEndpoint = endpoint.replace(/\/+$/, "");

  if (baseEndpoint.endsWith("/openai/v1")) {
    baseEndpoint = baseEndpoint.slice(0, -"/openai/v1".length);
  } else if (baseEndpoint.endsWith("/openai")) {
    baseEndpoint = baseEndpoint.slice(0, -"/openai".length);
  }

  return baseEndpoint;
}

function getFoundryKnowledgeConfig() {
  const projectEndpoint = process.env.FOUNDRY_PROJECT_ENDPOINT;
  const agentName = process.env.FOUNDRY_AGENT_NAME;
  const knowledgeRequired = process.env.FOUNDRY_KNOWLEDGE_REQUIRED === "true";

  if (!projectEndpoint || !agentName) {
    return {
      enabled: false,
      knowledgeRequired,
      missing: [
        !projectEndpoint ? "FOUNDRY_PROJECT_ENDPOINT" : null,
        !agentName ? "FOUNDRY_AGENT_NAME" : null
      ].filter(Boolean)
    };
  }

  return {
    enabled: true,
    knowledgeRequired,
    projectEndpoint: normalizeFoundryProjectEndpoint(projectEndpoint),
    agentName
  };
}

function compactContractSignals(contractText, maxChars = 3000) {
  return contractText.length > maxChars
    ? `${contractText.slice(0, maxChars)}\n\n[Contract signal excerpt truncated.]`
    : contractText;
}


function countPhrase(text, phrase) {
  const pattern = phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return (text.match(new RegExp(pattern, "gi")) || []).length;
}

function hasMasterServicesSignals(contractText) {
  const text = String(contractText || "");
  const workOrderCount = countPhrase(text, "Work Order");
  const statementOfWorkCount = countPhrase(text, "Statement of Work");

  return (
    workOrderCount >= 5 ||
    statementOfWorkCount >= 3 ||
    /future\s+Work\s+Order/i.test(text) ||
    /Services\s+means\s+the\s+services\s+described\s+(within|in)\s+any\s+Work\s+Order/i.test(text) ||
    /Work\s+Order\s+issued\s+under\s+this\s+Agreement/i.test(text) ||
    /On\s+both\s+parties\s+signing\s+a\s+completed\s+statement\s+of\s+work/i.test(text)
  );
}

function applyClassificationOverrides(parsed, contractText) {
  if (!parsed || typeof parsed !== "object") return parsed;

  const masterSignals = hasMasterServicesSignals(contractText);
  const serviceLikeType =
    parsed.primaryType === "Provision of Services Agreement - Agency" ||
    parsed.primaryType === "Research Services Agreement - Agency" ||
    parsed.primaryType === "Other / Unknown";

  if (masterSignals && serviceLikeType) {
    parsed.secondaryTypes = Array.isArray(parsed.secondaryTypes) ? parsed.secondaryTypes : [];

    if (!parsed.secondaryTypes.includes(parsed.primaryType) && parsed.primaryType !== "Other / Unknown") {
      parsed.secondaryTypes.unshift(parsed.primaryType);
    }

    parsed.primaryType = "Master Services Agreement";
    parsed.selectedTemplate = "UoA-Master Services Agreement Template (1).docx";
    parsed.confidence = Math.max(typeof parsed.confidence === "number" ? parsed.confidence : 0, 0.9);
    parsed.evidence = [
      "The agreement repeatedly uses Work Orders / future Work Orders, indicating an umbrella framework for future service engagements.",
      ...(Array.isArray(parsed.evidence) ? parsed.evidence : [])
    ].slice(0, 5);
    parsed.needsHumanConfirmation = false;
  }

  return parsed;
}

function getTemplateFileHints(contractType, classification) {
  const hints = new Set([
    ...(TEMPLATE_FILE_HINTS[contractType] || []),
    ...POLICY_FILE_HINTS
  ]);

  const selectedTemplate = classification?.selectedTemplate || "";
  const selectedTemplateLower = selectedTemplate.toLowerCase();

  if (selectedTemplateLower.includes("incoming")) {
    for (const hint of TEMPLATE_FILE_HINTS[contractType] || []) {
      if (hint.toLowerCase().includes("incoming")) hints.add(hint);
    }
  }

  if (selectedTemplateLower.includes("outgoing") || selectedTemplateLower.includes("outbound")) {
    for (const hint of TEMPLATE_FILE_HINTS[contractType] || []) {
      if (hint.toLowerCase().includes("outgoing") || hint.toLowerCase().includes("outbound")) {
        hints.add(hint);
      }
    }
  }

  return [...hints];
}

function buildKnowledgeBaseQuery({ contractText, contractType, classification }) {
  const fileHints = getTemplateFileHints(contractType, classification);

  return `
Search the uploaded knowledge base for University of Auckland standard contract templates and contracting position documents relevant to this contract review.

Contract type to search for:
${contractType || "Other / Unknown"}

Classifier-selected template:
${classification?.selectedTemplate || "Not specified"}

Prefer these uploaded file names when relevant:
${fileHints.map(name => `- ${name}`).join("\n")}

Also retrieve the contracting positions, approvals, and escalation protocol if relevant.

Return a compact review context with:
1. Source file names used.
2. The most relevant template clauses or policy excerpts.
3. Any incoming/outgoing or direction-specific template choice.
4. Gaps where no matching uploaded knowledge base document was found.

Only use the uploaded knowledge base. Do not invent template clauses.

Contract signal excerpt for retrieval:
${compactContractSignals(contractText)}
`;
}

let cachedAgentsClient = null;
let cachedAgentsEndpoint = null;

function getAgentsClient(projectEndpoint) {
  if (cachedAgentsClient && cachedAgentsEndpoint === projectEndpoint) {
    return cachedAgentsClient;
  }
  cachedAgentsClient = new AgentsClient(projectEndpoint, new DefaultAzureCredential());
  cachedAgentsEndpoint = projectEndpoint;
  return cachedAgentsClient;
}

async function retrieveKnowledgeBaseContext({ contractText, contractType, classification }) {
  const config = getFoundryKnowledgeConfig();

  if (!config.enabled) {
    const warning =
      `Foundry knowledge base retrieval skipped. Missing: ${config.missing.join(", ")}.`;

    if (config.knowledgeRequired) {
      throw new Error(warning);
    }

    return {
      enabled: false,
      used: false,
      warning,
      context: ""
    };
  }

  const query = buildKnowledgeBaseQuery({ contractText, contractType, classification });

  try {
    const client = getAgentsClient(config.projectEndpoint);

    const thread = await client.threads.create();
    await client.messages.create(thread.id, "user", query);

    const poller = client.runs.createAndPoll(thread.id, config.agentName);
    const run = await poller.pollUntilDone();

    if (run.status !== "completed") {
      throw new Error(
        run.lastError?.message || `Foundry run ended with status ${run.status}.`
      );
    }

    const messages = client.messages.list(thread.id, { order: "desc" });
    const texts = [];

    for await (const message of messages) {
      if (message.role !== "assistant") continue;
      const part = (message.content || []).find(c => c.type === "text" && "text" in c);
      if (part) {
        texts.push(part.text.value);
        break;
      }
    }

    const context = texts.join("\n").trim();

    return {
      enabled: true,
      used: Boolean(context),
      query,
      context,
      raw: { threadId: thread.id, runId: run.id, runStatus: run.status }
    };
  } catch (error) {
    console.error("[Foundry] retrieval failed:", error?.message || error);

    const message = error?.message || "Foundry knowledge base retrieval failed.";

    if (config.knowledgeRequired) {
      throw error;
    }

    return {
      enabled: true,
      used: false,
      warning: message,
      details: error?.details,
      context: ""
    };
  }
}

async function classifyContractType(contractText) {
  const systemPrompt = `
You are a research contract intake classifier for the University of Auckland Research Grants and Contracts team.

Your only task is to classify the contract type. Do not review risks. Do not provide legal advice.

Choose exactly one primaryType from this list:
- Confidential Disclosure Agreement
- Data Access Agreement - Incoming Agency
- Data Access Agreement - Outgoing
- Data Transfer Agreement - Incoming
- Data Transfer Agreement - Outgoing
- Material Transfer Agreement - Outbound Key Materials
- Master Services Agreement
- Material Transfer Agreement - Incoming
- Material Transfer Agreement - Outgoing
- Provision of Services Agreement - Agency
- Research Collaboration Agreement
- Research Services Agreement - Agency
- Student Research Agreement
- Subcontractor Agreement
- Other / Unknown

Use clause signals, not the file name.

Direction and data-transfer priority rules:
- First determine whether the contract is mainly about transferring, sharing, receiving, accessing, or using data.
- If the contract contains terms such as Data, data sharing, clinical data, health information, personal information, privacy, data protection, data breach, data contravention, loss of data, secure transfer of data, or approved purpose for data use, classify it as a Data Transfer Agreement or Data Access Agreement before considering Confidential Disclosure Agreement.
- Do not classify a contract as Confidential Disclosure Agreement only because it contains confidentiality, non-disclosure, Discloser, Recipient, or Confidential Information wording.
- Confidential Disclosure Agreement should be used only where the main purpose is confidentiality/non-disclosure, not transfer or use of data.

Data Transfer Agreement direction:
- Data Transfer Agreement - Incoming: an external Provider, Discloser, agency, company, hospital, or other non-UoA party provides or transfers data to the University. Indicators include "University is Recipient", "Provider provides Data to the University", "Discloser provides data to the Recipient", or "University wishes to obtain data".
- Data Transfer Agreement - Outgoing: the University provides or transfers data to another party. Indicators include "University provides Data", "Data held by the University", "Recipient wishes to obtain data held by the University", or "University agrees to provide the Recipient with Data".

If both confidentiality and data-transfer signals are present, prefer Data Transfer Agreement and choose Incoming or Outgoing based on the direction of data flow.

Priority rule:
- If the contract contains repeated "Work Order", "Statement of Work", "future Work Order", "work order issued under this Agreement", or similar umbrella/framework signals, classify it as Master Services Agreement even if the University is described as a service provider.
- Provision of Services Agreement - Agency is for a single services arrangement without a master framework for future work orders or statements of work.
- Research Services Agreement - Agency is for research-specific services, testing, analysis, expertise, or research deliverables; do not use it for general master/work-order frameworks.

Classification and UoA template mapping:
- Confidential Disclosure Agreement: mutual or one-way confidentiality / non-disclosure for discussions, evaluation, negotiations, or exchange of confidential information, where the main purpose is NOT transfer, receipt, sharing, access, or use of a dataset. Template: UoA-CDA Two Way Template.docx.
- Data Access Agreement - Incoming Agency: the University is granted access to data held by an external Provider, usually through a database, portal, repository, system, login, access period, or secure access arrangement. The key signal is access to externally held data, not receipt of a transferred dataset. Template: UoA-Data Access Agreement Agency Template (incoming) May 2024 (1).docx.
- Data Access Agreement - Outgoing: another party accesses data held by the University. Template: UoA-Data Access Agreement Template (outgoing) May 2024.docx.
- Data Transfer Agreement - Incoming: an external Provider / Discloser / agency / company provides, discloses, supplies, transfers, sends, copies, delivers, or makes available data, datasets, clinical data, health information, personal information, de-identified data, records, or confidential information containing data to the University. The key signal is that the University receives or may copy/use a provided dataset. Template: UoA-Data Transfer Agreement Template (incoming) April 2024 .docx.

Critical distinction:
- If the contract says the external party "provides", "discloses", "supplies", "transfers", "sends", "copies", "delivers", or "makes available" data to the University, classify it as Data Transfer Agreement - Incoming.
- If the University is the Recipient and the external party is the Discloser or Provider of clinical data, health information, personal information, de-identified data, records, datasets, or confidential information containing data, classify it as Data Transfer Agreement - Incoming.
- Do not classify as Data Access Agreement - Incoming Agency merely because the contract uses the words "access", "licence", "copy", or "use".
- Data Access Agreement - Incoming Agency should be used only where the main arrangement is access to data held in another party's database, portal, repository, or system.

- Data Transfer Agreement - Outgoing: the University transfers or provides Data held by the University to an external Recipient, and the external Recipient receives, accesses, stores, uses, or analyses the Data. Template: UoA-Data Transfer Agreement Template (outgoing) April 2024.docx.
- Material Transfer Agreement - Outbound Key Materials: University provides key materials using the older key materials outbound template. Template: UoA-MTA_Outbound for Key Materials-April 2018.docx.
- Master Services Agreement: umbrella/master services terms governing future statements of work or service orders. Template: UoA-Master Services Agreement Template (1).docx.
- Material Transfer Agreement - Incoming: University receives materials, samples, progeny, modifications, or other research materials. Template: UoA-Material_Transfer_Agreement incoming-Aug 2024.docx.
- Material Transfer Agreement - Outgoing: University provides materials, samples, progeny, modifications, or other research materials. Template: UoA-Material_Transfer_Agreement_outgoing_Aug 2024.docx.
- Provision of Services Agreement - Agency: University or counterparty provides non-research or agency services under a provision of services arrangement. Template: UoA-Provision of Services Agreement (Agency)_June 2024.docx.
- Research Collaboration Agreement: joint research, shared work, shared governance, steering committee, or collaborative outputs. Template: UoA-Research Collaboration Agreement Template (1).docx.
- Research Services Agreement - Agency: University provides research services to an agency/client. Template: UoA-Research Services Agreement (Agency) _June 2024 .docx.
- Student Research Agreement: student project involving Student, Client, and University. Template: UoA-Student Research Agreement Template (April 2018).docx.
- Subcontractor Agreement: subcontractor services under a prime funded research project, flow-down terms, sponsor terms, or work package under a main award. Template: UoA-Template Subcontractor Agreement_2025 (1) (1).docx.
- If no clear match is found, classify it as Other / Unknown.

Return ONLY valid JSON. Do not use markdown.

Use this exact structure:
{
  "primaryType": "Material Transfer Agreement - Incoming",
  "selectedTemplate": "UoA-Material_Transfer_Agreement incoming-Aug 2024.docx",
  "confidence": 0.86,
  "secondaryTypes": ["Research Collaboration Agreement"],
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
    "Confidential Disclosure Agreement",
    "Data Access Agreement - Incoming Agency",
    "Data Access Agreement - Outgoing",
    "Data Transfer Agreement - Incoming",
    "Data Transfer Agreement - Outgoing",
    "Material Transfer Agreement - Outbound Key Materials",
    "Master Services Agreement",
    "Material Transfer Agreement - Incoming",
    "Material Transfer Agreement - Outgoing",
    "Provision of Services Agreement - Agency",
    "Research Collaboration Agreement",
    "Research Services Agreement - Agency",
    "Student Research Agreement",
    "Subcontractor Agreement",
    "Other / Unknown"
  ]);

  if (!allowedTypes.has(parsed.primaryType)) {
    parsed.primaryType = "Other / Unknown";
  }

  parsed.selectedTemplate = String(parsed.selectedTemplate || "Not specified").trim();

  if (typeof parsed.confidence !== "number") {
    parsed.confidence = 0;
  }

  if (!Array.isArray(parsed.secondaryTypes)) {
    parsed.secondaryTypes = [];
  }

  if (!Array.isArray(parsed.evidence)) {
    parsed.evidence = [];
  }

  applyClassificationOverrides(parsed, contractText);

  parsed.needsHumanConfirmation =
    parsed.needsHumanConfirmation === true ||
    parsed.primaryType === "Other / Unknown" ||
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

async function reviewContract(contractText, contractType, clauseInventory, knowledgeBaseRetrieval) {
  const knowledgeContext = knowledgeBaseRetrieval?.used
    ? knowledgeBaseRetrieval.context
    : "No Foundry knowledge base context was retrieved for this run. Use only the mock position store below and clearly avoid claiming that specific uploaded template text was reviewed.";

  const systemPrompt = `
You are a Research Contract Adviser Agent for a proof-of-concept system.

Your task is to assist human contract reviewers by comparing uploaded research contracts against University of Auckland standard templates and preferred contracting positions in the knowledge base.

You must not provide legal advice, approve contracts, reject contracts, or make final decisions. Your output is only a review aid for the RGC Team.

Use the selected or classified contract type as the starting point, then identify the most relevant UoA standard template from this mapping:

- Confidential Disclosure Agreement: UoA-CDA Two Way Template.docx.
- Data Access Agreement - Incoming Agency: UoA-Data Access Agreement Agency Template (incoming) May 2024 (1).docx.
- Data Access Agreement - Outgoing: UoA-Data Access Agreement Template (outgoing) May 2024.docx.
- Data Transfer Agreement - Incoming: UoA-Data Transfer Agreement Template (incoming) April 2024 .docx.
- Data Transfer Agreement - Outgoing: UoA-Data Transfer Agreement Template (outgoing) April 2024.docx.
- Material Transfer Agreement - Outbound Key Materials: UoA-MTA_Outbound for Key Materials-April 2018.docx.
- Master Services Agreement: UoA-Master Services Agreement Template (1).docx.
- Material Transfer Agreement - Incoming: UoA-Material_Transfer_Agreement incoming-Aug 2024.docx.
- Material Transfer Agreement - Outgoing: UoA-Material_Transfer_Agreement_outgoing_Aug 2024.docx.
- Provision of Services Agreement - Agency: UoA-Provision of Services Agreement (Agency)_June 2024.docx.
- Research Collaboration Agreement: UoA-Research Collaboration Agreement Template (1).docx.
- Research Services Agreement - Agency: UoA-Research Services Agreement (Agency) _June 2024 .docx.
- Student Research Agreement: UoA-Student Research Agreement Template (April 2018).docx.
- Subcontractor Agreement: UoA-Template Subcontractor Agreement_2025 (1) (1).docx.
- If no clear match is found, use Other / Unknown and explain the uncertainty.

When retrieved knowledge base context is provided, use it as the primary source for:
- Template clause comparison.
- Template names.
- Contracting positions.
- Required approvals and escalation.

If retrieved knowledge base context is not provided, say so through conservative rationale and do not invent uploaded template content.

Review every recognised top-level clause from the provided clause inventory where possible. Do not only report problematic clauses. If the inventory misses an obvious top-level clause, include it and explain that it was inferred from the contract text.

Review key clauses especially carefully, including:
- Liability and exclusions
- Indemnities
- Insurance
- Warranties
- Confidentiality
- Publication
- Intellectual property and moral rights
- Publicity
- Payment terms
- Governing law and jurisdiction
- Dispute resolution
- Termination
- Variations and extensions
- No disrepute clauses
- Data access or data transfer
- Material use restrictions
- Commercial use restrictions
- AI-generated outputs or AI tool usage

Use the following UoA mock position store when assigning flags:

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

For clauses not covered by this mock position store:
- Use green only if there is clearly no issue identified based on the available knowledge base.
- Use amber if contract manager review is sensible because wording is broad, unusual, or operationally important.
- Use blue if no matching UoA position or template is available.
- Do not invent UoA rules, template clauses, or legal requirements.

Flag system:
- green = aligns with UoA preferred position or standard template, or no issue is identified.
- amber = partially aligns, falls within acceptable position, or requires contract manager review.
- red = conflicts with UoA preferred position, creates significant risk, violates a required UoA rule, or requires escalation.
- blue = not covered by current UoA positions or templates.

Important rules:
- Every identifiable clause should appear in the final output.
- The flags array must contain one item for every recognised top-level clause in the clause inventory.
- If a clause has no issue, still include it as a Green Flag.
- If a clause has no issue, still include it as a Green Flag.
- For Green flags, the rationale must start with: "Aligns because ..."
- Do not write "No issue identified."
- Do not write "The clause appears to align."
- If no matching UoA position or template is found, use Blue Flag.
- If you cannot review a recognised clause using the available knowledge base, include that clause as a Blue Flag instead of omitting it.
- Use clause references from the recognised clause inventory where possible. Do not invent clause numbers.
- If multiple templates appear relevant, choose the best match and explain the uncertainty in the rationale.
- For every Red Flag, the matchedPosition field must contain the exact UoA rule, prohibition, or template requirement that is being violated.

- For every Red Flag, the rationale must start with this exact phrase:
  "Conflicts with standard"

- For every Red Flag, use this rationale format:
  "Conflicts with standard '[specific UoA rule/prohibition]'. The uploaded clause states '[short contract wording]', which conflicts because [clear reason]."

- Do not use vague wording such as:
  "conflicts with UoA position"
  "not acceptable"
  "requires review"
  unless you also state the specific rule being violated.

- Example:
  matchedPosition: "Preferred Contracting Position: New Zealand law. Acceptable Contracting Position: Foreign governing law only with prior approval or legal review."
  rationale: "Conflicts with standard 'Governing law should be New Zealand law unless an approved exception applies'. The uploaded clause states 'This Agreement shall be construed in accordance with the laws of Australia', which conflicts because it applies Australian law without showing any approved exception."
  
  For every clause, provide:
- Clause number or title
- Short clause snippet
- Matched UoA position or template
- Flag category
- Rationale
- Required escalation, if any
- Confidence level: High / Medium / Low

Rationale wording rules:
- Green rationale must start with: "Aligns because ..."
- Amber rationale must start with: "Partial alignment; deviation because ..."
- Red rationale must start with: "Conflicts with standard because ..."
- Blue rationale must start with: "Not addressed in current standards because ..."
- Do not include the label "Rationale:" inside the rationale field.
- Do not write "No issue identified."
- Do not write "The clause appears to align."
- The rationale must be one complete natural sentence.

Return ONLY valid JSON.
Do not include markdown.
Do not include explanations outside the JSON.
Do not wrap the JSON in code fences.

Use this exact JSON structure:

{
  "detectedType": "Material Transfer Agreement - Incoming",
  "selectedTemplate": "UoA-Material_Transfer_Agreement incoming-Aug 2024.docx",
  "knowledgeBaseDocuments": [
    "Document name or section used"
  ],
  "flags": [
    {
      "severity": "green",
      "clauseRef": "Clause 1",
      "title": "Definitions",
      "snippet": "Short quote from the uploaded contract",
      "matchedPosition": "For Red Flags, include Preferred Contracting Position, Acceptable Contracting Position, and Required Escalation where available. For non-Red Flags, include the relevant UoA position or template clause.",
      "rationale": "Aligns because the clause is consistent with the relevant UoA position or template and does not create a concern based on the available knowledge base.",
      "requiredEscalation": "None",
      "confidence": "High"
    }
  ],
  "summary": {
    "greenCount": 0,
    "amberCount": 0,
    "redCount": 0,
    "blueCount": 0,
    "overallRisk": "Low / Medium / High",
    "keyIssues": [
      "Brief summary of important issues, or 'No major issues identified.'"
    ]
  },
  "disclaimer": "This report is a decision-support tool only and requires review by the RGC Team. It does not constitute legal advice."
}

Severity values must be exactly one of:
- green
- amber
- red
- blue
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

Retrieved Foundry knowledge base context:
${knowledgeContext}

Use clause references from the recognised clause inventory where possible. Do not invent clause numbers.

Please review this contract:

${contractText}
`
      }
    ],
    temperature: 0.2,
    maxTokens: 4000
  });

  const parsed = parseModelJson(raw, "Model did not return valid review JSON.");
  return normalizeReviewResult(parsed, contractType, clauseInventory);
}

app.post("/api/classify-contract", async (req, res) => {
  try {
    const { contractText } = req.body;

    if (!contractText || typeof contractText !== "string") {
      return res.status(400).json({ error: "contractText is required." });
    }

    const classification = await classifyContractType(contractText);
    res.json({ classification });
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

app.post("/api/review-contract", async (req, res) => {
  try {
    const { contractText, contractType, classification: confirmedClassification } = req.body;

    if (!contractText || typeof contractText !== "string") {
      return res.status(400).json({ error: "contractText is required." });
    }

    let finalContractType = contractType;
    let classification = confirmedClassification || null;

    if (!finalContractType || finalContractType === "auto") {
      classification = await classifyContractType(contractText);
      finalContractType = classification.primaryType;
    }

    const clauseInventory = await extractClauses(contractText, finalContractType);
    const knowledgeBaseRetrieval = await retrieveKnowledgeBaseContext({
      contractText,
      contractType: finalContractType,
      classification
    });
    const review = await reviewContract(
      contractText,
      finalContractType,
      clauseInventory,
      knowledgeBaseRetrieval
    );

    if (classification) {
      review.classification = classification;
      if (review.selectedTemplate === "Not specified" && classification.selectedTemplate) {
        review.selectedTemplate = classification.selectedTemplate;
      }
    }

    review.clauseInventory = clauseInventory;
    review.knowledgeBaseRetrieval = {
      enabled: knowledgeBaseRetrieval.enabled,
      used: knowledgeBaseRetrieval.used,
      warning: knowledgeBaseRetrieval.warning,
      query: knowledgeBaseRetrieval.query
    };

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
