import { WAREHOUSE_FILTER_CATALOG, WAREHOUSE_NUMERIC_FIELDS } from "./warehouse-fields";

const errorResponses = Object.fromEntries(Object.entries({
  "400": { description: "Invalid query parameters or record identifier." },
  "401": { description: "API key missing, invalid, revoked, or expired." },
  "403": { description: "The employee is inactive or the API key lacks the required scope. CRM_IDENTITY_UNAVAILABLE means the live CRM email, linked member ID, or assignment token cannot be matched uniquely." },
  "404": { description: "The record or document does not exist or is not available to this employee." },
  "405": { description: "Method not allowed. This service exposes read-only operations." },
  "414": { description: "The request URL exceeds 4,096 characters." },
  "422": { description: "Invalid query parameters or record identifier." },
  "429": { description: "Request limit exceeded. Retry after a delay." },
  "503": { description: "The service or its data source is temporarily unavailable. CRM_CONFIGURATION means live assignment verification lacks valid server configuration. CRM_AUTHORIZATION_UNAVAILABLE means live assignment results cannot be verified completely within the supported limits. CRM_SOURCE_STALE means the opportunity mirror has no successful latest sync within the last 30 minutes. CRM records are withheld when any of these checks fails." },
}).map(([status, response]) => [status, {
  ...response,
  content: { "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } } },
}]));

const envelopeSchema = {
  type: "object",
  required: ["data", "meta"],
  properties: {
    data: { type: "object", additionalProperties: true },
    meta: {
      type: "object",
      required: ["requestId", "generatedAt"],
      properties: {
        requestId: { type: "string" },
        generatedAt: { type: "string", format: "date-time" },
      },
    },
  },
};

const collectionSchema = {
  ...envelopeSchema,
  properties: {
    ...envelopeSchema.properties,
    data: {
      type: "object",
      required: ["items", "nextCursor"],
      properties: {
        items: { type: "array", items: { type: "object", additionalProperties: true } },
        nextCursor: { type: ["string", "integer", "null"] },
      },
    },
  },
};

function jsonResponses(description: string, collection = false, dataSchema?: Record<string, unknown>, collectionProperties: Record<string, unknown> = {}) {
  const schema = collection ? collectionSchema : envelopeSchema;
  const responseSchema = dataSchema ? {
    ...schema,
    properties: {
      ...schema.properties,
      data: collection ? {
        ...collectionSchema.properties.data,
        properties: {
          ...collectionSchema.properties.data.properties,
          items: { type: "array", items: dataSchema },
          ...collectionProperties,
        },
      } : dataSchema,
    },
  } : schema;
  return {
    "200": {
      description,
      headers: {
        "Cache-Control": { description: "Authenticated responses are private and must not be cached.", schema: { type: "string", example: "private, no-store" } },
      },
      content: { "application/json": { schema: responseSchema } },
    },
    ...errorResponses,
  };
}

const limitParameter = {
  name: "limit",
  in: "query",
  description: "Maximum number of records to return.",
  schema: { type: "integer", minimum: 1, maximum: 25, default: 10 },
};

const warehouseIdParameter = {
  name: "id",
  in: "path",
  required: true,
  description: "Warehouse identifier returned by warehouse search.",
  schema: { type: "integer", minimum: 1 },
};

function textParameter(name: string, description: string) {
  return { name, in: "query", description, schema: { type: "string", minLength: 1, maxLength: 80 } };
}

const nullableLabel = { type: ["string", "null"] };
const nullableNumber = { type: ["number", "null"] };
const nullableDate = { type: ["string", "null"], format: "date-time" };
const warehouseFieldEvidenceSchema = {
  type: "object",
  required: ["kind"],
  additionalProperties: false,
  properties: {
    kind: { type: "string", enum: ["exact", "approximate", "range", "unknown"] },
    value: { type: "number", description: "Parsed exact value or recorded approximation. An approximation must not be described as confirmed." },
    lower: { type: "number", description: "Lower endpoint of a parsed recorded range, in the output field's units." },
    upper: { type: "number", description: "Upper endpoint of a parsed recorded range, in the output field's units." },
    source: { type: "string", maxLength: 100, description: "Sanitised measurement text when safe to include; never arbitrary notes or contact information." },
  },
};
const warehouseMatchingPolicySchema = {
  type: "object",
  required: ["mode", "include_unknown", "range_matching", "guidance"],
  properties: {
    mode: { type: "string", enum: ["permissive", "strict"] },
    include_unknown: { type: "boolean" },
    range_matching: { type: "string", const: "overlap" },
    guidance: { type: "string", description: "Instructions for interpreting candidates and communicating verification requirements." },
  },
};
const warehouseFilterDefinitionSchema = {
  type: "object",
  required: ["name", "type", "description"],
  properties: {
    name: { type: "string" },
    type: { type: "string", enum: ["string", "number", "integer"] },
    description: { type: "string" },
    enum: { type: "array", items: { type: "string" } },
    minimum: { type: "number" },
    exclusiveMinimum: { type: "number" },
    maximum: { type: "number" },
    default: { type: ["string", "number", "boolean"] },
  },
};
const crmStages = ["NEW_LEAD", "RFQ_RECEIVED", "PROPOSAL_SHARED", "FOLLOW_UP", "SITE_VISIT", "NEGOTIATION", "AGREEMENT_WORK", "MONEY_COLLECTION", "RFQ_NOT_RELEVANT", "DEAL_LOST", "DEAL_CLOSED", "DEAL_ON_HOLD"];
const warehouseSchema = {
  type: "object",
  additionalProperties: false,
  required: ["field_evidence", "verification_required"],
  description: "Allowlisted recorded warehouse facts and measurement evidence. Numeric scalars contain only exact parsed values; approximate/range values remain null with their interpretation in field_evidence. A candidate flagged verification_required must explicitly be presented as needing verification. Even exact parsing and the separate verified flag do not establish physical accuracy or current availability.",
  properties: {
    id: { type: "integer" },
    city: nullableLabel,
    state: nullableLabel,
    zone: nullableLabel,
    micromarkets: { type: "array", items: { type: "string" }, description: "Sanitised locality/category tags; not contact addresses." },
    warehouse_type: nullableLabel,
    total_space_sqft: { type: "array", items: { type: "integer" } },
    ...Object.fromEntries(WAREHOUSE_NUMERIC_FIELDS.map(field => [field.field, {
      type: [field.integer ? "integer" : "number", "null"],
      ...(field.allowZero ? { minimum: 0 } : { exclusiveMinimum: 0 }),
      maximum: field.maximum,
      description: "Exact parsed value in the field's named units; approximate/range/unknown values remain null. Inspect field_evidence and verification_required.",
    }])),
    availability: nullableLabel,
    status: nullableLabel,
    verified: { type: ["boolean", "null"] },
    fire_noc_available: { type: ["boolean", "null"], description: "Recorded availability flag; verify the approval documents for the proposed use." },
    lift_access: { type: ["boolean", "null"] },
    flooring_type: nullableLabel,
    listing_type: nullableLabel,
    land_type: nullableLabel,
    pollution_zone: nullableLabel,
    water_supply: nullableLabel,
    suitable_for: { type: "array", items: { type: "string" }, description: "Recorded suitability tags, not guarantees of permitted use." },
    handover_date: { type: ["string", "null"], format: "date" },
    field_evidence: {
      type: "object",
      description: "Evidence for numeric specification fields, keyed by the corresponding output field name. Preserve uncertainty and units when explaining a result.",
      additionalProperties: { $ref: "#/components/schemas/WarehouseFieldEvidence" },
    },
    verification_required: { type: "boolean", description: "When true, explicitly identify this candidate as requiring verification and explain the approximate, ranged, missing, or uninterpretable evidence. This flag is separate from verified." },
    created_at: nullableDate,
    updated_at: nullableDate,
  },
};
const opportunitySchema = {
  type: "object",
  additionalProperties: false,
  description: "Allowlisted CRM mirror facts authorized by current Twenty role and creator/assignment relationships. Facts retain their mirror timestamps. Null values are unknown or withheld.",
  properties: {
    id: { type: "string", format: "uuid" },
    name: nullableLabel,
    stage: { type: ["string", "null"], enum: [...crmStages, null] },
    priority_stars: { type: ["integer", "null"], minimum: 1, maximum: 5 },
    city: nullableLabel,
    company_name: nullableLabel,
    requirement_sqft: nullableNumber,
    micro_market: nullableLabel,
    last_contacted: nullableDate,
    next_follow_up: nullableDate,
    last_meaningful_update_at: nullableDate,
    last_meaningful_update_kind: { type: ["string", "null"], enum: ["opportunity", "note", "task", "attachment", "stage", null] },
    stage_entered_at: nullableDate,
    source_updated_at: nullableDate,
    last_polled_at: nullableDate,
  },
};
const sourceStatusReference = { $ref: "#/components/schemas/SourceStatus" };
const accessScopeSchema = { type: "string", enum: ["all", "created_or_assigned", "created", "assigned"], description: "Effective record visibility for this response. All means all non-deleted mirrored opportunities and requires the current Twenty Admin role." };
const sourceStreamSchema = {
  type: "object",
  required: ["source_watermark_at", "last_run_at", "status"],
  properties: {
    source_watermark_at: { ...nullableDate, description: "Latest source timestamp captured by the mirror." },
    last_run_at: { ...nullableDate, description: "Most recent mirror run; inspect status to determine whether it succeeded." },
    status: { type: "string", enum: ["ok", "error", "unknown"] },
  },
};
const knowledgeSummarySchema = {
  type: "object",
  required: ["id", "title", "summary", "updatedAt"],
  properties: {
    id: { type: "string" },
    title: { type: "string" },
    summary: { type: "string" },
    updatedAt: { type: "string", format: "date" },
  },
};

/** Public, credential-free description of the read-only REST surface. */
export function getOpenApiDocument() {
  return {
    openapi: "3.1.0",
    info: {
      title: "Wareongo Context API",
      version: "0.1.0",
      description: "Read-only company knowledge, warehouse specifications, and permitted CRM opportunities. Employees see created or assigned leads; verified Twenty admins see all mirrored leads. Send an employee API key in the Authorization header. The service enforces employee permissions and field allowlists before returning data. Authenticated responses must not be cached. Free-text notes, contact details, and raw media are not exposed. Start with GET /context or GET /context.md.",
    },
    servers: [{ url: "/api/v1" }],
    security: [{ bearerAuth: [] }],
    tags: [
      { name: "Context", description: "Discover the tools and knowledge available to the current employee." },
      { name: "Knowledge", description: "Reviewed Markdown knowledge. Requires knowledge:read." },
      { name: "Warehouses", description: "Permitted warehouse fields. Requires warehouses:read and active dashboard or administrator access in the employee roster." },
      { name: "CRM", description: "Requires crm:read and an active linked CRM user verified against live Twenty. Employees can read leads they created OR are assigned to. Current members of Twenty's built-in Admin role can read all mirrored leads; WAG dashboard admin status alone grants no such access. Incomplete or failed checks deny access. Mirror facts require a successful opportunity sync within 30 minutes." },
      { name: "Service", description: "Public service metadata without organisation records." },
    ],
    paths: {
      "/context": {
        get: {
          operationId: "getContext",
          tags: ["Context"],
          summary: "Get the employee's context index",
          description: "Returns allowed capabilities, the permitted knowledge index, and API entry points for this authenticated employee.",
          responses: jsonResponses("Context index for the authenticated employee.", false, {
            type: "object",
            required: ["employee_id", "scopes", "knowledge", "read_only", "api_specification", "context_markdown", "constraints"],
            properties: {
              employee_id: { type: "integer", description: "Internal employee identifier; no email or contact information is returned." },
              scopes: { type: "array", items: { type: "string", enum: ["knowledge:read", "warehouses:read", "crm:read"] } },
              knowledge: { type: "array", items: { $ref: "#/components/schemas/KnowledgeSummary" } },
              read_only: { type: "boolean", const: true },
              api_specification: { type: "string", const: "/api/v1/openapi.json" },
              context_markdown: { type: "string", const: "/api/v1/context.md" },
              constraints: {
                type: "object",
                properties: {
                  contacts: { type: "string", const: "excluded" },
                  notes_and_media: { type: "string", const: "excluded" },
                  crm_scope: { type: "string", const: "created or assigned; verified Twenty admins see all" },
                  max_page_size: { type: "integer", const: 25 },
                },
              },
            },
          }),
        },
      },
      "/context.md": {
        get: {
          operationId: "getContextMarkdown",
          tags: ["Context"],
          summary: "Read the Markdown bootstrap",
          description: "Requires knowledge:read. A compact starting page for an HTTP-capable agent, including the permitted wiki index and API usage instructions.",
          responses: {
            "200": { description: "Markdown bootstrap for the authenticated employee.", content: { "text/markdown": { schema: { type: "string" } } } },
            ...errorResponses,
          },
        },
      },
      "/wiki/search": {
        get: {
          operationId: "searchKnowledge",
          tags: ["Knowledge"],
          summary: "Search permitted knowledge pages",
          parameters: [
            { name: "q", in: "query", required: true, description: "Words to find in the knowledge library.", schema: { type: "string", minLength: 1, maxLength: 120 } },
            { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 10, default: 10 } },
          ],
          responses: jsonResponses("Matching permitted knowledge pages.", false, {
            type: "object",
            required: ["items"],
            properties: {
              items: {
                type: "array",
                items: {
                  ...knowledgeSummarySchema,
                  required: [...knowledgeSummarySchema.required, "snippet"],
                  properties: { ...knowledgeSummarySchema.properties, snippet: { type: "string" } },
                },
              },
            },
          }),
        },
      },
      "/wiki/pages/{id}": {
        get: {
          operationId: "readKnowledgePage",
          tags: ["Knowledge"],
          summary: "Read a permitted knowledge page",
          parameters: [
            { name: "id", in: "path", required: true, description: "Page identifier from context discovery or knowledge search.", schema: { type: "string" } },
            { name: "format", in: "query", description: "Set markdown to receive the page as Markdown text.", schema: { type: "string", enum: ["markdown"] } },
          ],
          responses: {
            ...jsonResponses("The permitted knowledge page and its content."),
            "200": {
              description: "JSON by default; Markdown text when format=markdown.",
              content: {
                "application/json": { schema: envelopeSchema },
                "text/markdown": { schema: { type: "string" } },
              },
            },
          },
        },
      },
      "/warehouses": {
        get: {
          operationId: "searchWarehouses",
          tags: ["Warehouses"],
          summary: "Search warehouses using permitted filters",
          description: "Returns visible warehouse candidates satisfying all supplied filters. Category values match exactly after trimming/case folding; Bangalore/Bengaluru and Gurgaon/Gurugram are city aliases. Area bounds must match one total_space_sqft entry, not the sum. Default match_mode=permissive admits plausible approximate values and recorded ranges overlapping numeric constraints. Always state when verification_required is true and preserve field_evidence; a match is not a confirmed specification. match_mode=strict excludes approximate/range constrained measurements. include_unknown=true independently admits missing/uninterpretable constrained numeric fields and flags them, even with strict mode; it does not bypass other filters. Discover supported parameters and current category values via /warehouses/filters. Contact lookup, arbitrary text/SQL, addresses, notes, and media are unavailable.",
          parameters: WAREHOUSE_FILTER_CATALOG.map(({ name, description, ...schema }) => ({
            name, in: "query", description, schema,
          })),
          responses: jsonResponses("Visible warehouse candidates with measurement evidence and the applied matching policy.", true, { $ref: "#/components/schemas/Warehouse" }, {
            matching_policy: { $ref: "#/components/schemas/WarehouseMatchingPolicy" },
          }),
        },
      },
      "/warehouses/filters": {
        get: {
          operationId: "getWarehouseFilters",
          tags: ["Warehouses"],
          summary: "Discover warehouse filters and current category options",
          description: "Returns the filter catalog and sanitised category values from visible warehouse records only, optionally narrowed by city/state. Each category returns at most 100 values. A truncated response is not a complete vocabulary; an omitted value or zero search results does not establish inventory absence. Requires warehouses:read.",
          parameters: WAREHOUSE_FILTER_CATALOG.filter(filter => ["city", "state"].includes(filter.name))
            .map(({ name, description, ...schema }) => ({ name, in: "query", description, schema })),
          responses: jsonResponses("Filter definitions and bounded category options from visible records.", false, {
            type: "object",
            required: ["catalog", "options", "truncated"],
            properties: {
              catalog: { type: "array", items: { $ref: "#/components/schemas/WarehouseFilterDefinition" } },
              options: { type: "object", additionalProperties: { type: "array", maxItems: 100, items: { type: "string" } } },
              truncated: { type: "boolean", description: "True when one or more option categories exceed the returned cap." },
            },
          }),
        },
      },
      "/warehouses/{id}": {
        get: {
          operationId: "getWarehouse",
          tags: ["Warehouses"],
          summary: "Get permitted warehouse specifications",
          description: "Returns recorded specifications plus field_evidence and verification_required. Explain uncertain values and explicitly state when this warehouse needs verification; omitted or null numeric values must not be replaced with a guessed scalar.",
          parameters: [warehouseIdParameter],
          responses: jsonResponses("Warehouse specifications containing only allowlisted fields.", false, { $ref: "#/components/schemas/Warehouse" }),
        },
      },
      "/crm/opportunities": {
        get: {
          operationId: "searchOpportunities",
          tags: ["CRM"],
          summary: "Search available CRM opportunities",
          description: "Defaults to leads created by OR assigned to the employee, or all mirrored leads for verified Twenty admins. view=created or view=assigned narrows either role to that employee's own records. Creation is checked using createdBy.workspaceMemberId, independently of assignment. ownerId alone does not grant access. New records may be absent until mirrored.",
          parameters: [
            textParameter("city", "Filter by requirement city."),
            { name: "stage", in: "query", description: "Filter by recorded CRM stage.", schema: { type: "string", enum: crmStages } },
            { name: "view", in: "query", description: "Choose the default permitted scope or narrow to your created/assigned leads. Cannot combine with assigned_to.", schema: { type: "string", enum: ["accessible", "created", "assigned"], default: "accessible" } },
            { name: "assigned_to", in: "query", description: "Compatibility alias for view=assigned. Only me is accepted; cannot combine with view.", schema: { type: "string", enum: ["me"] } },
            limitParameter,
            { name: "cursor", in: "query", description: "Opportunity cursor from the previous response's nextCursor.", schema: { type: "string", format: "uuid" } },
          ],
          responses: jsonResponses("Permitted opportunities with the applied access scope and mirror freshness information.", true, { $ref: "#/components/schemas/Opportunity" }, { access_scope: accessScopeSchema, source_status: sourceStatusReference }),
        },
      },
      "/crm/opportunities/{id}": {
        get: {
          operationId: "getOpportunity",
          tags: ["CRM"],
          summary: "Get a permitted CRM opportunity",
          description: "Requires live creator/assignment authorization or verified Twenty Admin membership. Unavailable or incomplete live verification denies CRM access.",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
          responses: jsonResponses("An authorized opportunity, with access scope and mirror freshness information.", false, { $ref: "#/components/schemas/OpportunityDetail" }),
        },
      },
      "/crm/my-briefing": {
        get: {
          operationId: "getMyBriefing",
          tags: ["CRM"],
          summary: "Get a briefing within the employee's permitted CRM scope",
          description: "Priorities and counts apply the same live-created-or-assigned scope as record reads; verified Twenty admins receive an organization-wide mirrored briefing. Inspect access_scope before describing coverage. Missing or unsynchronised facts remain unknown.",
          responses: jsonResponses("Permitted CRM briefing with access scope and mirror freshness information.", false, {
            type: "object",
            properties: {
              as_of: { type: "string", format: "date-time" },
              access_scope: accessScopeSchema,
              timezone: { type: "string", const: "Asia/Kolkata" },
              total_active: { type: "integer", minimum: 0 },
              counts_by_stage: { type: "object", additionalProperties: { type: "integer", minimum: 0 } },
              counts_by_sla: { type: "object", additionalProperties: { type: "integer", minimum: 0 } },
              follow_up_overdue: { type: "integer", minimum: 0, description: "Follow-ups due before the current IST calendar day." },
              priorities: {
                type: "array", maxItems: 20,
                items: {
                  ...opportunitySchema,
                  properties: {
                    ...opportunitySchema.properties,
                    sla: { type: "string", enum: ["red", "yellow", "green", "unknown", "not_tracked"] },
                    days_in_stage: { type: ["integer", "null"] },
                  },
                },
              },
              source_status: sourceStatusReference,
            },
          }),
        },
      },
      "/openapi.json": {
        get: {
          operationId: "getOpenApi",
          tags: ["Service"],
          summary: "Get this API description",
          security: [],
          responses: { "200": { description: "Public OpenAPI document.", content: { "application/json": { schema: { type: "object" } } } } },
        },
      },
      "/health": {
        servers: [{ url: "/api" }],
        get: {
          operationId: "getHealth",
          tags: ["Service"],
          summary: "Check the service process",
          description: "Public liveness check. It does not return organisation data or prove that the database is reachable.",
          security: [],
          responses: { "200": { description: "Service process is running.", content: { "application/json": { schema: { type: "object" } } } } },
        },
      },
    },
    components: {
      schemas: {
        Warehouse: warehouseSchema,
        WarehouseFieldEvidence: warehouseFieldEvidenceSchema,
        WarehouseMatchingPolicy: warehouseMatchingPolicySchema,
        WarehouseFilterDefinition: warehouseFilterDefinitionSchema,
        Opportunity: opportunitySchema,
        OpportunityDetail: {
          ...opportunitySchema,
          properties: { ...opportunitySchema.properties, access_scope: accessScopeSchema, source_status: sourceStatusReference },
        },
        SourceStatus: {
          type: "object",
          required: ["opportunities", "notes", "tasks"],
          properties: {
            opportunities: sourceStreamSchema,
            notes: sourceStreamSchema,
            tasks: sourceStreamSchema,
          },
        },
        KnowledgeSummary: knowledgeSummarySchema,
        ErrorResponse: {
          type: "object",
          required: ["error", "meta"],
          properties: {
            error: {
              type: "object",
              required: ["code", "message"],
              properties: { code: { type: "string" }, message: { type: "string" } },
            },
            meta: envelopeSchema.properties.meta,
          },
        },
      },
      securitySchemes: {
        bearerAuth: {
          type: "http",
          scheme: "bearer",
          description: "Employee API key issued by the context engine administrator. Send as Authorization: Bearer <key>. Never put credentials in URL query parameters.",
        },
      },
    },
  };
}
