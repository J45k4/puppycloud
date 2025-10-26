
import { dockerBackend } from "../main";
import { BackendRequestError } from "../backends/errors";

export async function handleGetFileContent(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const filePath = url.searchParams.get('path');
  const containerId = url.searchParams.get('id');

  if (!containerId) {
    return new Response(JSON.stringify({ error: 'Container ID is required' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  if (!filePath) {
    return new Response(JSON.stringify({ error: 'File path is required' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  try {
    const info = await dockerBackend.getInstancePath(containerId, filePath);
    if (info.type !== 'file') {
      return new Response(JSON.stringify({ error: 'Path is not a file' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    let content = "";
    if (info.encoding === 'base64' && info.content) {
        content = Buffer.from(info.content, 'base64').toString('utf8');
    } else if (info.content) {
        content = info.content;
    }

    return new Response(JSON.stringify({ content }), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error) {
    if (error instanceof BackendRequestError && error.statusCode === 404) {
      return new Response(JSON.stringify({ error: 'File not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response(JSON.stringify({ error: 'Failed to read file' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}
