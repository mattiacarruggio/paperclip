import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockRegistry = vi.hoisted(() => ({
  getById: vi.fn(),
  getByKey: vi.fn(),
}));

const mockLifecycle = vi.hoisted(() => ({
  load: vi.fn(),
  upgrade: vi.fn(),
  unload: vi.fn(),
  enable: vi.fn(),
  disable: vi.fn(),
}));

vi.mock("../services/plugin-registry.js", () => ({
  pluginRegistryService: () => mockRegistry,
}));

vi.mock("../services/plugin-lifecycle.js", () => ({
  pluginLifecycleManager: () => mockLifecycle,
}));

vi.mock("../services/activity-log.js", () => ({
  logActivity: vi.fn(),
}));

vi.mock("../services/live-events.js", () => ({
  publishGlobalLiveEvent: vi.fn(),
}));

const pluginId = "11111111-1111-4111-8111-111111111111";
const endpointKey = "github-push";

async function createApp(routeOverrides: {
  db?: unknown;
  webhookDeps?: unknown;
} = {}) {
  const [{ pluginRoutes }, { errorHandler }] = await Promise.all([
    import("../routes/plugins.js"),
    import("../middleware/index.js"),
  ]);

  const loader = { installPlugin: vi.fn() };

  const app = express();
  app.use(express.json());
  app.use("/api", pluginRoutes(
    (routeOverrides.db ?? {}) as never,
    loader as never,
    undefined,
    routeOverrides.webhookDeps as never,
    undefined,
    undefined,
  ));
  app.use(errorHandler);

  return app;
}

function workerManagerStub() {
  return {
    workerManager: {
      call: vi.fn(),
    },
  };
}

describe.sequential("MAT-669 webhook ingest error responses", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns generic 404 when plugin does not exist", async () => {
    mockRegistry.getById.mockResolvedValue(null);
    mockRegistry.getByKey.mockResolvedValue(null);
    const app = await createApp({ webhookDeps: workerManagerStub() });

    const res = await request(app)
      .post(`/api/plugins/${pluginId}/webhooks/${endpointKey}`)
      .send({ event: "push" });

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "webhook not delivered" });
  });

  it("returns generic 404 when plugin is not in ready state", async () => {
    mockRegistry.getById.mockResolvedValue({
      id: pluginId,
      status: "disabled",
      manifestJson: {
        capabilities: ["webhooks.receive"],
        webhooks: [{ endpointKey }],
      },
    });
    const app = await createApp({ webhookDeps: workerManagerStub() });

    const res = await request(app)
      .post(`/api/plugins/${pluginId}/webhooks/${endpointKey}`)
      .send({ event: "push" });

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "webhook not delivered" });
    expect(res.body.error).not.toMatch(/disabled|ready|status/i);
  });

  it("returns generic 404 when plugin manifest is missing", async () => {
    mockRegistry.getById.mockResolvedValue({
      id: pluginId,
      status: "ready",
      manifestJson: null,
    });
    const app = await createApp({ webhookDeps: workerManagerStub() });

    const res = await request(app)
      .post(`/api/plugins/${pluginId}/webhooks/${endpointKey}`)
      .send({ event: "push" });

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "webhook not delivered" });
    expect(res.body.error).not.toMatch(/manifest/i);
  });

  it("returns generic 404 when plugin lacks webhooks.receive capability", async () => {
    mockRegistry.getById.mockResolvedValue({
      id: pluginId,
      status: "ready",
      manifestJson: {
        capabilities: ["tools.invoke"],
        webhooks: [{ endpointKey }],
      },
    });
    const app = await createApp({ webhookDeps: workerManagerStub() });

    const res = await request(app)
      .post(`/api/plugins/${pluginId}/webhooks/${endpointKey}`)
      .send({ event: "push" });

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "webhook not delivered" });
    expect(res.body.error).not.toMatch(/capabilit|webhooks\.receive/i);
  });

  it("returns generic 404 when endpointKey is not declared by the plugin", async () => {
    mockRegistry.getById.mockResolvedValue({
      id: pluginId,
      status: "ready",
      manifestJson: {
        capabilities: ["webhooks.receive"],
        webhooks: [{ endpointKey: "stripe-charge" }],
      },
    });
    const app = await createApp({ webhookDeps: workerManagerStub() });

    const res = await request(app)
      .post(`/api/plugins/${pluginId}/webhooks/${endpointKey}`)
      .send({ event: "push" });

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "webhook not delivered" });
    expect(res.body.error).not.toMatch(/declared|endpointKey/i);
  });

  it("does not dispatch to the worker on any rejection path", async () => {
    const deps = workerManagerStub();
    mockRegistry.getById.mockResolvedValue(null);
    mockRegistry.getByKey.mockResolvedValue(null);
    const app = await createApp({ webhookDeps: deps });

    await request(app)
      .post(`/api/plugins/${pluginId}/webhooks/${endpointKey}`)
      .send({ event: "push" });

    expect(deps.workerManager.call).not.toHaveBeenCalled();
  });
});
