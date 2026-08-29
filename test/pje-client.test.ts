import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { after, before, test } from "node:test";
import { PjeClient } from "../src/pje-client.js";

let baseUrl = "";
let activeRequests = 0;
let maximumActiveRequests = 0;
let server: ReturnType<typeof createServer>;

const readBody = async (request: IncomingMessage): Promise<string> => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
};

const respond = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
  const url = new URL(request.url ?? "/", baseUrl);

  if (url.pathname === "/set-cookie") {
    response.setHeader("Set-Cookie", "pje-session=kept; Path=/; HttpOnly");
    response.end("stored");
    return;
  }

  if (url.pathname === "/check-cookie") {
    response.end(request.headers.cookie ?? "");
    return;
  }

  if (url.pathname === "/latin1") {
    response.setHeader("Content-Type", "text/plain; charset=ISO-8859-1");
    response.end(Buffer.from([0x6f, 0x6c, 0xe1]));
    return;
  }

  if (url.pathname === "/utf8") {
    response.setHeader("Content-Type", "text/plain; charset=UTF-8");
    response.end(Buffer.from("ação", "utf8"));
    return;
  }

  if (url.pathname === "/form") {
    const body = await readBody(request);
    response.setHeader("Content-Type", "text/plain; charset=UTF-8");
    response.end(`${request.method}:${request.headers["content-type"]}:${body}`);
    return;
  }

  if (url.pathname === "/redirect") {
    response.statusCode = 302;
    response.setHeader("Location", "/redirected");
    response.setHeader("Set-Cookie", "redirect-cookie=present; Path=/");
    response.end();
    return;
  }

  if (url.pathname === "/redirected") {
    response.end(request.headers.cookie ?? "");
    return;
  }

  if (url.pathname === "/binary") {
    response.setHeader("Content-Type", "application/pdf");
    response.end(Buffer.from([0x25, 0x50, 0x44, 0x46, 0x00, 0xff]));
    return;
  }

  if (url.pathname === "/binary-form") {
    const body = await readBody(request);
    response.end(Buffer.from(body, "utf8"));
    return;
  }

  if (url.pathname === "/status") {
    response.statusCode = 429;
    response.end("rate limited");
    return;
  }

  if (url.pathname === "/paced") {
    activeRequests += 1;
    maximumActiveRequests = Math.max(maximumActiveRequests, activeRequests);
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    activeRequests -= 1;
    response.end("done");
    return;
  }

  response.statusCode = 404;
  response.end("missing");
};

before(async () => {
  server = createServer((request, response) => {
    void respond(request, response).catch((error: unknown) => {
      response.statusCode = 500;
      response.end(error instanceof Error ? error.message : String(error));
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Test server did not bind to a TCP port");
  }
  baseUrl = `http://127.0.0.1:${address.port}/`;
});

after(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
});

test("keeps cookies between requests", async () => {
  const client = new PjeClient({ baseUrl, delayMs: 0 });

  await client.getText("/set-cookie");
  const response = await client.getText("/check-cookie");

  assert.match(response.body, /pje-session=kept/);
});

test("decodes ISO-8859-1 and UTF-8 from Content-Type", async () => {
  const client = new PjeClient({ baseUrl, delayMs: 0 });

  const latin1 = await client.getText("/latin1");
  const utf8 = await client.getText("/utf8");

  assert.equal(latin1.body, "olá");
  assert.equal(utf8.body, "ação");
});

test("posts URL-encoded forms and preserves status responses", async () => {
  const client = new PjeClient({ baseUrl, delayMs: 0 });
  const form = new URLSearchParams({ query: "ação", page: "2" });

  const submitted = await client.postFormText("/form", form, "/origin");
  const limited = await client.getText("/status");

  assert.equal(
    submitted.body,
    "POST:application/x-www-form-urlencoded:query=a%C3%A7%C3%A3o&page=2"
  );
  assert.equal(limited.status, 429);
  assert.equal(limited.body, "rate limited");
});

test("follows redirects with cookies and exposes the final URL", async () => {
  const client = new PjeClient({ baseUrl, delayMs: 0 });

  const response = await client.getText("/redirect");

  assert.equal(response.status, 200);
  assert.match(response.body, /redirect-cookie=present/);
  assert.equal(response.finalUrl, `${baseUrl}redirected`);
});

test("returns binary GET and form POST bodies as buffers", async () => {
  const client = new PjeClient({ baseUrl, delayMs: 0 });

  const pdf = await client.getBinary("/binary");
  const posted = await client.postFormBinary(
    "/binary-form",
    new URLSearchParams({ document: "123" })
  );

  assert.deepEqual(pdf.body, Buffer.from([0x25, 0x50, 0x44, 0x46, 0x00, 0xff]));
  assert.equal(posted.body.toString("utf8"), "document=123");
});

test("serializes concurrent requests and injects pacing sleep", async () => {
  const sleeps: number[] = [];
  maximumActiveRequests = 0;
  const client = new PjeClient({
    baseUrl,
    delayMs: 25,
    sleep: async (milliseconds) => {
      sleeps.push(milliseconds);
    }
  });

  await Promise.all([client.getText("/paced"), client.getText("/paced")]);

  assert.equal(maximumActiveRequests, 1);
  assert.deepEqual(sleeps, [25]);
});
