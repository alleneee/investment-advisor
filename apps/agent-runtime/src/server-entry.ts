import { PythonRpcClient } from './rpc.js';
import { createConfiguredServer } from './server.js';

const port = Number(process.env.PI_AGENT_PORT ?? 8081);
const pythonBaseUrl = process.env.PYTHON_API_BASE_URL ?? 'http://127.0.0.1:8000';
const rpc = new PythonRpcClient(pythonBaseUrl, process.env.INTERNAL_AGENT_TOKEN);
const server = await createConfiguredServer(rpc);

server.listen(port, '127.0.0.1', () => {
  process.stdout.write(`Pi advisor sidecar listening on http://127.0.0.1:${port}\n`);
});
