import { Mastra } from '@mastra/core/mastra';
import { VercelDeployer } from '@mastra/deployer-vercel';
import { MastraEditor } from '@mastra/editor';
import { PinoLogger } from '@mastra/loggers';
import {
  Observability,
  MastraStorageExporter,
  MastraPlatformExporter,
  SensitiveDataFilter,
} from '@mastra/observability';
import { queryAgent } from './agents/query-agent';
import { researchAgent } from './agents/research-agent';
import { insertAgent } from './agents/insert-agent';
import { vehicleResearchWorkflow } from './workflows/vehicle-research';
import { PostgresStore } from '@mastra/pg';
import { apiKeyAuth } from './server/auth';
import { isDeployed } from './runtime';
const storage = new PostgresStore({
  id: 'pg-storage',
  connectionString: process.env.SUPBASE_POSTGRES!,
  schemaName: 'mastra_memory',
  disableInit: false,
});

export const mastra = new Mastra({
  deployer: new VercelDeployer(),
  storage,
  server: { middleware: [apiKeyAuth] },
  agents: { queryAgent,  researchAgent, insertAgent},
  workflows: { vehicleResearchWorkflow },
  // The code-backed editor writes agent overrides to disk under codePath. That
  // works locally, but a deployment's filesystem is read-only outside /tmp, so
  // registering it there fails every request with ENOENT on mkdir.
  ...(isDeployed() ? {} : { editor: new MastraEditor({ source: 'code', codePath: 'mastra/editor' }) }),
  logger: new PinoLogger({ name: 'Mastra', level: 'info' }),
  observability: new Observability({
    configs: {
      default: {
        serviceName: 'auto-scoot',
        exporters: [new MastraStorageExporter(), new MastraPlatformExporter()],
        spanOutputProcessors: [new SensitiveDataFilter()],
      },
    },
  }),
});
