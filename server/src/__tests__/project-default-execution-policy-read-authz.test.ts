import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockProjectService = vi.hoisted(() => ({
  getById: vi.fn(),
  update: vi.fn(),
}));
const mockAccessService = vi.hoisted(() => ({
  decide: vi.fn(),
}));
const mockLogActivity = vi.hoisted(() => vi.fn());

vi.mock("../services/index.js", () => ({
  accessService: () => mockAccessService,
  environmentService: () => ({}),
  logActivity: mockLogActivity,
  projectService: () => mockProjectService,
  secretService: () => ({}),
  workspaceOperationService: () => ({}),
}));
vi.mock("../services/environments.js", () => ({ environmentService: () => ({}) }));
vi.mock("../services/secrets.js", () => ({ secretService: () => ({}) }));
vi.mock("../services/workspace-runtime.js", () => ({
  startRuntimeServicesForWorkspaceControl: vi.fn(),
  stopRuntimeServicesForProjectWorkspace: vi.fn(),
}));
vi.mock("../telemetry.js", () => ({ getTelemetryClient: vi.fn() }));

const { projectRoutes } = await import("../routes/projects.js");
const { errorHandler } = await import("../middleware/index.js");

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";

function buildProject(overrides: Record<string, unknown> = {}) {
  return {
    id: PROJECT_ID,
    companyId: "company-1",
    urlKey: "project-1",
    defaultExecutionPolicy: null,
    workspaces: [],
    ...overrides,
  };
}

function createApp(actor: Record<string, unknown>) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use("/api", projectRoutes({} as any));
  app.use(errorHandler);
  return app;
}

describe("GET /projects/:id/default-execution-policy authorization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockProjectService.getById.mockResolvedValue(buildProject());
  });

  it("denies a same-company agent whose project:read is scoped out", async () => {
    mockAccessService.decide.mockResolvedValue({
      allowed: false,
      action: "project:read",
      reason: "deny_low_trust_boundary",
      explanation: "Project is outside this low-trust boundary.",
    });
    const app = createApp({ type: "agent", agentId: "agent-1", companyId: "company-1", runId: "run-1" });

    const res = await request(app).get(`/api/projects/${PROJECT_ID}/default-execution-policy`);

    expect(res.status).toBe(403);
    expect(res.body.error).toBe("Project is outside this actor's authorization boundary");
  });

  it("returns the policy for an actor whose project:read is allowed", async () => {
    mockProjectService.getById.mockResolvedValue(
      buildProject({ defaultExecutionPolicy: { mode: "normal", commentRequired: true, stages: [] } }),
    );
    mockAccessService.decide.mockResolvedValue({
      allowed: true,
      action: "project:read",
      reason: "allow_company_agent",
      explanation: "Allowed by standard same-company agent visibility.",
    });
    const app = createApp({ type: "agent", agentId: "agent-1", companyId: "company-1", runId: "run-1" });

    const res = await request(app).get(`/api/projects/${PROJECT_ID}/default-execution-policy`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ defaultExecutionPolicy: { mode: "normal", commentRequired: true, stages: [] } });
  });
});
