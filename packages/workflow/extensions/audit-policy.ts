import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const AUDIT_ENTRY_TYPE = "suocode-tool-purpose-audit";
const SCHEMA_MARKER = Symbol.for("suocode-workflow.tool-purpose-field");
const PURPOSE_REGISTRY = Symbol.for("suocode-workflow.tool-purpose-registry");
const POLICY_STATE = Symbol.for("suocode-workflow.tool-purpose-policy-state");
const MAX_PURPOSE_LENGTH = 100;
const PURPOSE_DESCRIPTION = `本次工具调用的具体目的，1至${MAX_PURPOSE_LENGTH}字`;
const PURPOSE_FIELDS = ["purpose", "_auditPurpose", "__auditPurpose"] as const;
const MAX_PURPOSE_RECORDS = 5_000;

const TOOL_AUDIT_POLICY = `<tool_audit_policy>
每次调用任何工具时，都必须填写工具 schema 中的目的字段（通常为 purpose）：用 1 至 ${MAX_PURPOSE_LENGTH} 个字符具体说明本次调用的直接目的，不得使用“执行操作”“调用工具”等空泛表述。该字段只用于观察和审计，不代表向用户请求批准。
</tool_audit_policy>`;

type JsonRecord = Record<string, unknown>;

interface AuditEntryData {
  toolCallId: string;
  toolName: string;
  purpose: string;
  timestamp: number;
}

interface SchemaMarker {
  field: string;
}

function getPurposeRegistry(): Map<string, AuditEntryData> {
  const globals = globalThis as Record<PropertyKey, unknown>;
  const existing = globals[PURPOSE_REGISTRY];
  if (existing instanceof Map) {
    return existing as Map<string, AuditEntryData>;
  }

  const registry = new Map<string, AuditEntryData>();
  globals[PURPOSE_REGISTRY] = registry;
  return registry;
}

function rememberPurpose(data: AuditEntryData): void {
  const registry = getPurposeRegistry();
  registry.set(data.toolCallId, data);
  while (registry.size > MAX_PURPOSE_RECORDS) {
    const oldest = registry.keys().next().value as string | undefined;
    if (!oldest) break;
    registry.delete(oldest);
  }
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function decodeJsonPointerSegment(segment: string): string {
  return segment.replace(/~1/g, "/").replace(/~0/g, "~");
}

function resolveLocalRef(root: JsonRecord, ref: string): JsonRecord | undefined {
  if (!ref.startsWith("#/")) return undefined;

  let current: unknown = root;
  for (const rawSegment of ref.slice(2).split("/")) {
    if (!isRecord(current)) return undefined;
    current = current[decodeJsonPointerSegment(rawSegment)];
  }

  return isRecord(current) ? current : undefined;
}

function collectRootSchemaNodes(root: JsonRecord): JsonRecord[] {
  const nodes: JsonRecord[] = [];
  const seen = new Set<JsonRecord>();

  const visit = (node: JsonRecord): void => {
    if (seen.has(node)) return;
    seen.add(node);
    nodes.push(node);

    for (const keyword of ["allOf", "anyOf", "oneOf"] as const) {
      const branches = node[keyword];
      if (!Array.isArray(branches)) continue;
      for (const branch of branches) {
        if (isRecord(branch)) visit(branch);
      }
    }

    if (typeof node.$ref === "string") {
      const target = resolveLocalRef(root, node.$ref);
      if (target) visit(target);
    }
  };

  visit(root);
  return nodes;
}

function isOurPurposeSchema(value: unknown): boolean {
  return isRecord(value) && value.description === PURPOSE_DESCRIPTION;
}

function choosePurposeField(nodes: JsonRecord[]): string {
  for (const candidate of PURPOSE_FIELDS) {
    const conflicts = nodes.some((node) => {
      if (!isRecord(node.properties)) return false;
      const existing = node.properties[candidate];
      return existing !== undefined && !isOurPurposeSchema(existing);
    });
    if (!conflicts) return candidate;
  }

  return `__auditPurpose_${Date.now().toString(36)}`;
}

function getSchemaMarker(schema: JsonRecord): SchemaMarker | undefined {
  const marker = (schema as JsonRecord & { [SCHEMA_MARKER]?: unknown })[
    SCHEMA_MARKER
  ];
  return isRecord(marker) && typeof marker.field === "string"
    ? { field: marker.field }
    : undefined;
}

function setSchemaMarker(schema: JsonRecord, field: string): void {
  Object.defineProperty(schema, SCHEMA_MARKER, {
    configurable: true,
    enumerable: false,
    value: { field },
  });
}

function patchSchema(schema: unknown, requestedField?: string): string | undefined {
  if (!isRecord(schema)) return undefined;

  const existingMarker = getSchemaMarker(schema);
  const nodes = collectRootSchemaNodes(schema);
  const field = requestedField ?? existingMarker?.field ?? choosePurposeField(nodes);

  for (const node of nodes) {
    if (!Object.isExtensible(node)) return undefined;

    const currentProperties = node.properties;
    if (currentProperties !== undefined && !isRecord(currentProperties)) {
      return undefined;
    }

    const existingFieldSchema = isRecord(currentProperties)
      ? currentProperties[field]
      : undefined;
    if (existingFieldSchema !== undefined && !isOurPurposeSchema(existingFieldSchema)) {
      return undefined;
    }

    node.properties = {
      ...(isRecord(currentProperties) ? currentProperties : {}),
      [field]: {
        type: "string",
        minLength: 1,
        maxLength: MAX_PURPOSE_LENGTH,
        description: PURPOSE_DESCRIPTION,
      },
    };

    const required = node.required;
    if (required !== undefined && !Array.isArray(required)) return undefined;
    node.required = [
      ...new Set([
        ...(Array.isArray(required)
          ? required.filter((item): item is string => typeof item === "string")
          : []),
        field,
      ]),
    ];
  }

  setSchemaMarker(schema, field);
  return field;
}

function patchPayloadDescriptor(
  descriptor: JsonRecord,
  fieldsByTool: Map<string, string>,
): boolean {
  let changed = false;

  const patchNamedSchema = (name: unknown, schema: unknown): void => {
    if (typeof name !== "string") return;
    const field = fieldsByTool.get(name);
    if (!field) return;
    if (patchSchema(schema, field)) changed = true;
  };

  patchNamedSchema(descriptor.name, descriptor.parameters);
  patchNamedSchema(descriptor.name, descriptor.input_schema);
  patchNamedSchema(descriptor.name, descriptor.parametersJsonSchema);

  if (isRecord(descriptor.function)) {
    patchNamedSchema(descriptor.function.name, descriptor.function.parameters);
  }

  if (isRecord(descriptor.toolSpec)) {
    const inputSchema = isRecord(descriptor.toolSpec.inputSchema)
      ? descriptor.toolSpec.inputSchema.json
      : undefined;
    patchNamedSchema(descriptor.toolSpec.name, inputSchema);
  }

  const functionDeclarations = descriptor.functionDeclarations;
  if (Array.isArray(functionDeclarations)) {
    for (const declaration of functionDeclarations) {
      if (isRecord(declaration)) {
        changed = patchPayloadDescriptor(declaration, fieldsByTool) || changed;
      }
    }
  }

  return changed;
}

function patchProviderPayload(
  payload: unknown,
  fieldsByTool: Map<string, string>,
): boolean {
  const seen = new Set<object>();
  let changed = false;

  const visit = (value: unknown, key?: string): void => {
    if (!isRecord(value) || seen.has(value)) return;
    seen.add(value);

    if (
      key === "tools" ||
      key === "toolConfig" ||
      key === "functionDeclarations" ||
      "parameters" in value ||
      "input_schema" in value ||
      "toolSpec" in value
    ) {
      changed = patchPayloadDescriptor(value, fieldsByTool) || changed;
    }

    for (const [childKey, child] of Object.entries(value)) {
      if (Array.isArray(child)) {
        for (const item of child) visit(item, childKey);
      } else if (isRecord(child)) {
        visit(child, childKey);
      }
    }
  };

  visit(payload);
  return changed;
}

function purposeLength(value: string): number {
  return Array.from(value).length;
}

function isValidPurpose(value: string): boolean {
  const length = purposeLength(value);
  return (
    length >= 1 &&
    length <= MAX_PURPOSE_LENGTH &&
    !/[\u0000-\u001f\u007f]/.test(value)
  );
}

function auditEnabled(): boolean {
  const state = (globalThis as Record<PropertyKey, unknown>)[POLICY_STATE];
  return state instanceof Map ? state.get("*") !== false : true;
}

export default function auditPolicyExtension(pi: ExtensionAPI): void {
  const fieldsByTool = new Map<string, string>();
  const warnedTools = new Set<string>();

  const patchAllToolSchemas = (): string[] => {
    const failed: string[] = [];

    for (const tool of pi.getAllTools()) {
      const field = patchSchema(tool.parameters);
      if (field) fieldsByTool.set(tool.name, field);
      else failed.push(tool.name);
    }

    return failed;
  };

  const reportPatchFailures = (failed: string[], hasUI: boolean, notify: (message: string) => void): void => {
    const newlyFailed = failed.filter((toolName) => !warnedTools.has(toolName));
    if (newlyFailed.length === 0) return;
    for (const toolName of newlyFailed) warnedTools.add(toolName);
    if (hasUI) {
      notify(`这些工具无法加入目的审计字段：${newlyFailed.join(", ")}`);
    }
  };

  pi.on("session_start", (_event, ctx) => {
    if (!auditEnabled()) return;
    // toolCallId is already globally unique across sessions, and rememberPurpose()
    // self-bounds via MAX_PURPOSE_RECORDS eviction — clearing here would wipe live
    // entries belonging to any OTHER concurrently open session.
    for (const entry of ctx.sessionManager.getEntries()) {
      if (
        entry.type === "custom" &&
        entry.customType === AUDIT_ENTRY_TYPE &&
        isRecord(entry.data) &&
        typeof entry.data.toolCallId === "string" &&
        typeof entry.data.toolName === "string" &&
        typeof entry.data.purpose === "string" &&
        typeof entry.data.timestamp === "number"
      ) {
        rememberPurpose(entry.data as unknown as AuditEntryData);
      }
    }

    const failed = patchAllToolSchemas();
    reportPatchFailures(failed, ctx.hasUI, (message) =>
      ctx.ui.notify(message, "warning"),
    );
  });

  pi.on("turn_start", () => {
    if (!auditEnabled()) return;
    patchAllToolSchemas();
  });

  pi.on("before_agent_start", (event) => {
    if (!auditEnabled()) return;
    patchAllToolSchemas();

    let systemPrompt = event.systemPrompt;
    if (!systemPrompt.includes("<tool_audit_policy>")) {
      systemPrompt += `\n\n${TOOL_AUDIT_POLICY}`;
    }
    return { systemPrompt };
  });

  pi.on("before_provider_request", (event) => {
    if (!auditEnabled()) return;
    patchAllToolSchemas();
    if (patchProviderPayload(event.payload, fieldsByTool)) {
      return event.payload;
    }
    return undefined;
  });

  pi.on("tool_result", () => {
    if (!auditEnabled()) return;
    patchAllToolSchemas();
  });

  pi.on("tool_call", (event, ctx) => {
    if (!auditEnabled()) return;
    const input = event.input as Record<string, unknown>;
    const preferredField = fieldsByTool.get(event.toolName);
    const field = [preferredField, ...PURPOSE_FIELDS].find(
      (candidate): candidate is string =>
        typeof candidate === "string" && candidate in input,
    );
    const rawPurpose = field ? input[field] : undefined;
    const purpose = typeof rawPurpose === "string" ? rawPurpose.trim() : "";

    if (!isValidPurpose(purpose)) {
      return {
        block: true,
        reason: `工具调用必须提供 1 至 ${MAX_PURPOSE_LENGTH} 字、单行且具体的目的描述；请修正后重试。`,
      };
    }

    const auditEntry: AuditEntryData = {
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      purpose,
      timestamp: Date.now(),
    };
    rememberPurpose(auditEntry);
    pi.appendEntry<AuditEntryData>(AUDIT_ENTRY_TYPE, auditEntry);

    if (field) delete input[field];
    return undefined;
  });
}
