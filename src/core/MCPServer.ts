import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "../transports/stdio/server.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  SubscribeRequestSchema,
  UnsubscribeRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { ToolProtocol } from "../tools/BaseTool.js";
import { PromptProtocol } from "../prompts/BasePrompt.js";
import { ResourceProtocol } from "../resources/BaseResource.js";
import { readFileSync } from "fs";
import { join, dirname, resolve } from "path";
import { logger } from "./Logger.js";
import { ToolLoader } from "../loaders/toolLoader.js";
import { PromptLoader } from "../loaders/promptLoader.js";
import { ResourceLoader } from "../loaders/resourceLoader.js";
import { BaseTransport } from "../transports/base.js";
import { SSEServerTransport } from "../transports/sse/server.js";
import { SSETransportConfig, DEFAULT_SSE_CONFIG } from "../transports/sse/types.js";

export type TransportType = "stdio" | "sse";

export interface TransportConfig {
  type: TransportType;
  options?: SSETransportConfig & {
    auth?: SSETransportConfig['auth'];
  };
}

export interface MCPServerConfig {
  name?: string;
  version?: string;
  basePath?: string;
  transport?: TransportConfig;
}

export type ServerCapabilities = {
  tools?: {
    enabled: true;
  };
  schemas?: {
    enabled: true;
  };
  prompts?: {
    enabled: true;
  };
  resources?: {
    enabled: true;
  };
};

export class MCPServer {
  private server!: Server;
  private toolsMap: Map<string, ToolProtocol> = new Map();
  private promptsMap: Map<string, PromptProtocol> = new Map();
  private resourcesMap: Map<string, ResourceProtocol> = new Map();
  private toolLoader: ToolLoader;
  private promptLoader: PromptLoader;
  private resourceLoader: ResourceLoader;
  private serverName: string;
  private serverVersion: string;
  private basePath: string;
  private transportConfig: TransportConfig;
  private capabilities: ServerCapabilities = {
    tools: { enabled: true }
  };
  private isRunning: boolean = false;
  private transport?: BaseTransport;
  private shutdownPromise?: Promise<void>;
  private shutdownResolve?: () => void;

  constructor(config: MCPServerConfig = {}) {
    this.basePath = this.resolveBasePath(config.basePath);
    this.serverName = config.name ?? this.getDefaultName();
    this.serverVersion = config.version ?? this.getDefaultVersion();
    this.transportConfig = config.transport ?? { type: "stdio" };

    logger.info(
      `Initializing MCP Server: ${this.serverName}@${this.serverVersion}`
    );

    this.toolLoader = new ToolLoader(this.basePath);
    this.promptLoader = new PromptLoader(this.basePath);
    this.resourceLoader = new ResourceLoader(this.basePath);

    logger.debug(`Looking for tools in: ${join(dirname(this.basePath), 'tools')}`);
    logger.debug(`Looking for prompts in: ${join(dirname(this.basePath), 'prompts')}`);
    logger.debug(`Looking for resources in: ${join(dirname(this.basePath), 'resources')}`);
  }

  private resolveBasePath(configPath?: string): string {
    if (configPath) {
      return configPath;
    }
    if (process.argv[1]) {
      return process.argv[1];
    }
    return process.cwd();
  }

  private createTransport(): BaseTransport {
    logger.debug(`Creating transport: ${this.transportConfig.type}`);
    
    let transport: BaseTransport;
    switch (this.transportConfig.type) {
      case "sse": {
        const sseConfig = this.transportConfig.options 
          ? { ...DEFAULT_SSE_CONFIG, ...this.transportConfig.options }
          : DEFAULT_SSE_CONFIG;
        transport = new SSEServerTransport(sseConfig);
        break;
      }
      case "stdio":
        logger.info("Starting stdio transport");
        transport = new StdioServerTransport();
        break;
      default:
        throw new Error(`Unsupported transport type: ${this.transportConfig.type}`);
    }

    transport.onclose = () => {
      logger.info("Transport connection closed");
      this.stop().catch(error => {
        logger.error(`Error during shutdown: ${error}`);
        process.exit(1);
      });
    };

    transport.onerror = (error) => {
      logger.error(`Transport error: ${error}`);
    };

    return transport;
  }

  private readPackageJson(): any {
    try {
      const projectRoot = process.cwd();
      const packagePath = join(projectRoot, "package.json");
      
      try {
        const packageContent = readFileSync(packagePath, "utf-8");
        const packageJson = JSON.parse(packageContent);
        logger.debug(`Successfully read package.json from project root: ${packagePath}`);
        return packageJson;
      } catch (error) {
        logger.warn(`Could not read package.json from project root: ${error}`);
        return null;
      }
    } catch (error) {
      logger.warn(`Could not read package.json: ${error}`);
      return null;
    }
  }

  private getDefaultName(): string {
    const packageJson = this.readPackageJson();
    if (packageJson?.name) {
      logger.info(`Using name from package.json: ${packageJson.name}`);
      return packageJson.name;
    }
    logger.error("Couldn't find project name in package json");
    return "unnamed-mcp-server";
  }

  private getDefaultVersion(): string {
    const packageJson = this.readPackageJson();
    if (packageJson?.version) {
      logger.info(`Using version from package.json: ${packageJson.version}`);
      return packageJson.version;
    }
    return "0.0.0";
  }

  private setupHandlers() {
    this.server.setRequestHandler(ListToolsRequestSchema, async (request) => {
      logger.debug(`Received ListTools request: ${JSON.stringify(request)}`);
      
      const tools = Array.from(this.toolsMap.values()).map(
        (tool) => tool.toolDefinition
      );
      
      logger.debug(`Found ${tools.length} tools to return`);
      logger.debug(`Tool definitions: ${JSON.stringify(tools)}`);
      
      const response = {
        tools: tools,
        nextCursor: undefined
      };
      
      logger.debug(`Sending ListTools response: ${JSON.stringify(response)}`);
      return response;
    });

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      logger.debug(`Tool call request received for: ${request.params.name}`);
      logger.debug(`Tool call arguments: ${JSON.stringify(request.params.arguments)}`);

      const tool = this.toolsMap.get(request.params.name);
      if (!tool) {
        const availableTools = Array.from(this.toolsMap.keys());
        const errorMsg = `Unknown tool: ${request.params.name}. Available tools: ${availableTools.join(", ")}`;
        logger.error(errorMsg);
        throw new Error(errorMsg);
      }

      try {
        logger.debug(`Executing tool: ${tool.name}`);
        const toolRequest = {
          params: request.params,
          method: "tools/call" as const,
        };

        const result = await tool.toolCall(toolRequest);
        logger.debug(`Tool execution successful: ${JSON.stringify(result)}`);
        return result;
      } catch (error) {
        const errorMsg = `Tool execution failed: ${error}`;
        logger.error(errorMsg);
        throw new Error(errorMsg);
      }
    });

    if (this.capabilities.prompts) {
      this.server.setRequestHandler(ListPromptsRequestSchema, async () => {
        return {
          prompts: Array.from(this.promptsMap.values()).map(
            (prompt) => prompt.promptDefinition
          ),
        };
      });

      this.server.setRequestHandler(GetPromptRequestSchema, async (request) => {
        const prompt = this.promptsMap.get(request.params.name);
        if (!prompt) {
          throw new Error(
            `Unknown prompt: ${
              request.params.name
            }. Available prompts: ${Array.from(this.promptsMap.keys()).join(
              ", "
            )}`
          );
        }

        return {
          messages: await prompt.getMessages(request.params.arguments),
        };
      });
    }

    if (this.capabilities.resources) {
      this.server.setRequestHandler(ListResourcesRequestSchema, async () => {
        return {
          resources: Array.from(this.resourcesMap.values()).map(
            (resource) => resource.resourceDefinition
          ),
        };
      });

      this.server.setRequestHandler(
        ReadResourceRequestSchema,
        async (request) => {
          const resource = this.resourcesMap.get(request.params.uri);
          if (!resource) {
            throw new Error(
              `Unknown resource: ${
                request.params.uri
              }. Available resources: ${Array.from(this.resourcesMap.keys()).join(
                ", "
              )}`
            );
          }

          return {
            contents: await resource.read(),
          };
        }
      );

      this.server.setRequestHandler(SubscribeRequestSchema, async (request) => {
        const resource = this.resourcesMap.get(request.params.uri);
        if (!resource) {
          throw new Error(`Unknown resource: ${request.params.uri}`);
        }

        if (!resource.subscribe) {
          throw new Error(
            `Resource ${request.params.uri} does not support subscriptions`
          );
        }

        await resource.subscribe();
        return {};
      });

      this.server.setRequestHandler(UnsubscribeRequestSchema, async (request) => {
        const resource = this.resourcesMap.get(request.params.uri);
        if (!resource) {
          throw new Error(`Unknown resource: ${request.params.uri}`);
        }

        if (!resource.unsubscribe) {
          throw new Error(
            `Resource ${request.params.uri} does not support subscriptions`
          );
        }

        await resource.unsubscribe();
        return {};
      });
    }
  }

  private async detectCapabilities(): Promise<ServerCapabilities> {
    if (await this.promptLoader.hasPrompts()) {
      this.capabilities.prompts = { enabled: true };
      logger.debug("Prompts capability enabled");
    }

    if (await this.resourceLoader.hasResources()) {
      this.capabilities.resources = { enabled: true };
      logger.debug("Resources capability enabled");
    }

    return this.capabilities;
  }

  async start() {
    try {
      if (this.isRunning) {
        throw new Error("Server is already running");
      }

      const tools = await this.toolLoader.loadTools();
      this.toolsMap = new Map(
        tools.map((tool: ToolProtocol) => [tool.name, tool])
      );

      const prompts = await this.promptLoader.loadPrompts();
      this.promptsMap = new Map(
        prompts.map((prompt: PromptProtocol) => [prompt.name, prompt])
      );

      const resources = await this.resourceLoader.loadResources();
      this.resourcesMap = new Map(
        resources.map((resource: ResourceProtocol) => [resource.uri, resource])
      );

      await this.detectCapabilities();

      logger.debug("Creating MCP Server instance");
      this.server = new Server(
        {
          name: this.serverName,
          version: this.serverVersion,
        },
        {
          capabilities: this.capabilities
        }
      );

      logger.debug(`Server created with capabilities: ${JSON.stringify(this.capabilities)}`);
      this.setupHandlers();
      
      logger.info("Starting transport...");
      this.transport = this.createTransport();
      
      const originalTransportSend = this.transport.send.bind(this.transport);
      this.transport.send = async (message) => {
        logger.debug(`Transport sending message: ${JSON.stringify(message)}`);
        return originalTransportSend(message);
      };

      this.transport.onmessage = async (message: any) => {
        logger.debug(`Transport received message: ${JSON.stringify(message)}`);
        
        try {
          if (message.method === 'initialize') {
            logger.debug('Processing initialize request');
            
            await this.transport?.send({
              jsonrpc: "2.0" as const,
              id: message.id,
              result: {
                protocolVersion: "2024-11-05",
                capabilities: this.capabilities,
                serverInfo: {
                  name: this.serverName,
                  version: this.serverVersion
                }
              }
            });

            await this.transport?.send({
              jsonrpc: "2.0" as const,
              method: "server/ready",
              params: {}
            });

            logger.debug('Initialization sequence completed');
            return;
          }

          if (message.method === 'tools/list') {
            logger.debug('Processing tools/list request');
            const tools = Array.from(this.toolsMap.values()).map(
              (tool) => tool.toolDefinition
            );
            
            await this.transport?.send({
              jsonrpc: "2.0" as const,
              id: message.id,
              result: {
                tools,
                nextCursor: undefined
              }
            });
            return;
          }

          logger.debug(`Unhandled message method: ${message.method}`);
        } catch (error) {
          logger.error(`Error handling message: ${error}`);
          if ('id' in message) {
            await this.transport?.send({
              jsonrpc: "2.0" as const,
              id: message.id,
              error: {
                code: -32000,
                message: String(error),
                data: { type: "handler_error" }
              }
            });
          }
        }
      };

      await this.server.connect(this.transport);
      logger.info("Transport connected successfully");

      logger.info(`Started ${this.serverName}@${this.serverVersion}`);
      logger.info(`Transport: ${this.transportConfig.type}`);

      if (tools.length > 0) {
        logger.info(
          `Tools (${tools.length}): ${Array.from(this.toolsMap.keys()).join(
            ", "
          )}`
        );
      }
      if (prompts.length > 0) {
        logger.info(
          `Prompts (${prompts.length}): ${Array.from(
            this.promptsMap.keys()
          ).join(", ")}`
        );
      }
      if (resources.length > 0) {
        logger.info(
          `Resources (${resources.length}): ${Array.from(
            this.resourcesMap.keys()
          ).join(", ")}`
        );
      }

      this.isRunning = true;

      process.on('SIGINT', () => {
        logger.info('Shutting down...');
        this.stop().catch(error => {
          logger.error(`Error during shutdown: ${error}`);
          process.exit(1);
        });
      });

      this.shutdownPromise = new Promise((resolve) => {
        this.shutdownResolve = resolve;
      });

      logger.info("Server running and ready for connections");
      await this.shutdownPromise;

    } catch (error) {
      logger.error(`Server initialization error: ${error}`);
      throw error;
    }
  }

  async stop() {
    if (!this.isRunning) {
      return;
    }

    try {
      logger.info("Stopping server...");
      await this.transport?.close();
      await this.server?.close();
      this.isRunning = false;
      logger.info('Server stopped');
      
      this.shutdownResolve?.();
      
      process.exit(0);
    } catch (error) {
      logger.error(`Error stopping server: ${error}`);
      throw error;
    }
  }
}
