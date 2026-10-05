/** Bind the shared catalogue to ordinary MCP tools. Loading hints never grant access. */
import type { McpServer } from '@modelcontextprotocol/server';
import type { KeyRegistration } from '../auth';
import { HttpError } from '../errors';
import {
  promptText,
  toolPlatforms,
  type PromptValues,
} from '../prompt-definitions';
import { TOOL_CATALOG, type ToolName, type ToolPlatform } from './catalog';

export const TOOL_DISCOVERY_KEY = 'wareongo/tool-discovery-v1';
export const CAPABILITIES = {
  context: 'Session capabilities, current clock and location resolution.',
  cms: 'Website CMS page types, CSV templates, page states, validated import diffs and private content drafts. Final editorial approval happens in the CMS.',
  knowledge: 'Find and read Wareongo company knowledge, guidance and policies.',
  warehouses:
    'Search warehouse properties, inspect recorded details, filters and supply summaries.',
  crm: 'Find permitted customer deals and RFQs, inspect requirements and activity, assess warehouse shortlists, and make authorized RFQ or note changes.',
  analytics:
    'Website traffic, Google Analytics reports and Google Search performance.',
  mail: 'Read, create and edit the employee’s app-created Gmail drafts.',
  gis: 'Create requested map points and reverse eligible unchanged creations.',
} satisfies Record<(typeof TOOL_CATALOG)[ToolName]['capability'], string>;

export function toolMetadata(name: ToolName) {
  const tool = TOOL_CATALOG[name];
  return structuredClone({
    [TOOL_DISCOVERY_KEY]: {
      capability: tool.capability,
      description: CAPABILITIES[tool.capability],
      loading: tool.loading,
    },
    ...('read' in tool
      ? { 'wareongo/context-read-v1': tool.read }
      : { 'wareongo/context-write-v1': tool.write }),
  });
}

export function toolRegistrar(
  server: McpServer,
  key: KeyRegistration,
  prompts: PromptValues,
  platform: ToolPlatform,
): McpServer['registerTool'] {
  const registered = new Set<string>();
  return (
    ...[name, config, callback]: Parameters<McpServer['registerTool']>
  ) => {
    if (!Object.hasOwn(TOOL_CATALOG, name) || registered.has(name))
      throw new Error('INVALID_TOOL_REGISTRATION');
    const toolName = name as ToolName;
    const tool = TOOL_CATALOG[toolName];
    const contract = 'read' in tool ? tool.read : tool.write;
    if (
      !contract.requiredScopes.every((scope) => key.scopes.includes(scope)) ||
      !toolPlatforms(toolName, prompts).includes(platform)
    ) {
      throw new HttpError(
        403,
        'TOOL_NOT_AVAILABLE',
        'Tool is unavailable for this employee and platform.',
      );
    }
    registered.add(name);
    return server.registerTool(
      name,
      {
        ...config,
        // Recovery-only contracts must not inherit an obsolete saved mutation prompt.
        description: 'fixedDescription' in tool && tool.fixedDescription
          ? tool.description
          : promptText(`tool.${toolName}`, prompts),
        annotations: { ...config.annotations, readOnlyHint: 'read' in tool },
        _meta: { ...config._meta, ...toolMetadata(toolName) },
      },
      callback,
    );
  };
}
