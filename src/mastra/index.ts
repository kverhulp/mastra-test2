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
import { PostgresStore } from '@mastra/pg';
const storage = new PostgresStore({
  connectionString: process.env.SUPBASE_POSTGRES!,
  schemaName: 'mastra_memory',
  disableInit: false, 
});

export const mastra = new Mastra({
  deployer: new VercelDeployer(),
  
  agents: { queryAgent,  researchAgent, insertAgent},
  editor: new MastraEditor({ source: 'code', codePath: 'mastra/editor' }),
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
