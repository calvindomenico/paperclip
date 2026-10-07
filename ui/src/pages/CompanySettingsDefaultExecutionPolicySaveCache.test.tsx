// @vitest-environment jsdom
//
// Regression coverage for a Greptile P2 finding on PR #15267, re-flagged on
// commit 15f0623090 as still open against the default-execution-policy
// editor in CompanySettings.tsx:
//
//   A successful policy save can restore the old text. `onSuccess` only
//   schedules a background refetch of the company-list cache
//   (`invalidateQueries` does not wait for it) before clearing the dirty
//   flag. The draft-sync effect treats "clean" as license to re-copy
//   `selectedCompany.defaultExecutionPolicy` into the draft (so background
//   refetches of this company get picked up) -- and if that effect reruns
//   before the refetch resolves, it copies the still-stale cached value back
//   over the just-saved text.
//
// Unlike CompanySettingsDefaultExecutionPolicy.test.tsx (which mocks
// ../context/CompanyContext entirely, so `selectedCompany` is a static value
// with no cache lag to reproduce), this file renders the real
// CompanyProvider against a mocked companiesApi.list that never resolves --
// deterministically reproducing "the background refetch hasn't caught up
// yet" instead of racing a timer against it.

import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Company } from "@paperclipai/shared";
import { TooltipProvider } from "@/components/ui/tooltip";
import { queryKeys } from "../lib/queryKeys";
import { CompanyProvider } from "../context/CompanyContext";

const mockCompaniesApi = vi.hoisted(() => ({
  list: vi.fn(),
  create: vi.fn(),
  detachInflightList: vi.fn(),
  update: vi.fn(),
  putDefaultExecutionPolicy: vi.fn(),
}));

const mockAuthApi = vi.hoisted(() => ({
  getSession: vi.fn(),
}));

const mockAssetsApi = vi.hoisted(() => ({
  uploadCompanyLogo: vi.fn(),
}));

const mockSetBreadcrumbs = vi.hoisted(() => vi.fn());
const mockPushToast = vi.hoisted(() => vi.fn());

vi.mock("../api/companies", () => ({ companiesApi: mockCompaniesApi }));
vi.mock("../api/auth", () => ({ authApi: mockAuthApi }));
vi.mock("../api/assets", () => ({ assetsApi: mockAssetsApi }));

vi.mock("../context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: mockSetBreadcrumbs }),
}));

vi.mock("../context/ToastContext", () => ({
  useOptionalToastActions: () => ({ pushToast: mockPushToast }),
}));

vi.mock("../hooks/useCloudInstance", () => ({
  useCloudInstance: () => null,
}));

vi.mock("../components/InteractionGovernancePanel", () => ({
  InteractionGovernancePanel: () => null,
  applyGovernanceChange: (current: unknown) => current,
}));

vi.mock("../components/CompanyPatternIcon", () => ({
  CompanyPatternIcon: () => null,
}));

vi.mock("./InstanceGeneralSettings", () => ({
  InstanceGeneralSettings: () => null,
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).ResizeObserver = (globalThis as any).ResizeObserver ?? ResizeObserverStub;

async function act(callback: () => void | Promise<void>) {
  let result: void | Promise<void> = undefined;
  flushSync(() => {
    result = callback();
  });
  await result;
}

async function flushReact() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

function getPolicyTextarea(container: HTMLElement): HTMLTextAreaElement {
  const textarea = container.querySelector(
    "[data-testid='company-settings-default-execution-policy-textarea']",
  );
  if (!textarea) throw new Error("Policy textarea not found");
  return textarea as HTMLTextAreaElement;
}

function setInputValue(input: HTMLTextAreaElement, value: string) {
  const prototype = Object.getPrototypeOf(input);
  const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

function makeCompany(overrides: Partial<Company> = {}): Company {
  return {
    id: "company-1",
    name: "Paperclip",
    description: null,
    status: "active",
    pauseReason: null,
    pausedAt: null,
    issuePrefix: "PAP",
    issueCounter: 1,
    budgetMonthlyCents: 0,
    spentMonthlyCents: 0,
    defaultResponsibleUserId: null,
    requireBoardApprovalForNewAgents: false,
    interactionResolverGovernance: {},
    defaultExecutionPolicy: null,
    feedbackDataSharingEnabled: false,
    feedbackDataSharingConsentAt: null,
    feedbackDataSharingConsentByUserId: null,
    feedbackDataSharingTermsVersion: null,
    logoAssetId: null,
    logoUrl: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as unknown as Company;
}

describe("CompanySettings default execution policy save vs. the company-list cache", () => {
  let container: HTMLDivElement;
  let root: Root;
  let queryClient: QueryClient;

  beforeEach(async () => {
    vi.clearAllMocks();
    localStorage.clear();
    container = document.createElement("div");
    document.body.appendChild(container);
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    mockAuthApi.getSession.mockResolvedValue(null);
    // Seed the account-scoped list cache directly (CompanyContext.test.tsx's
    // own pattern) so the provider has an answer on first render without
    // waiting on companiesApi.list. That call is instead left hanging below,
    // standing in for "the invalidateQueries-triggered refetch hasn't landed
    // yet" -- deterministically, rather than as a race against a timer.
    queryClient.setQueryData(queryKeys.companies.list(null), {
      companies: [makeCompany({ defaultExecutionPolicy: null })],
      unauthorized: false,
    });
    mockCompaniesApi.list.mockImplementation(() => new Promise(() => {}));
    mockCompaniesApi.update.mockResolvedValue(makeCompany());

    const { CompanySettings } = await import("./CompanySettings");

    root = createRoot(container);
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <MemoryRouter initialEntries={["/company/settings"]}>
            <TooltipProvider>
              <CompanyProvider>
                <CompanySettings />
              </CompanyProvider>
            </TooltipProvider>
          </MemoryRouter>
        </QueryClientProvider>,
      );
    });
    await flushReact();
    await flushReact();
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    queryClient.clear();
    container.remove();
    document.body.innerHTML = "";
    vi.clearAllMocks();
    vi.resetModules();
  });

  it("keeps the just-saved policy text visible when the background refetch hasn't landed yet", async () => {
    let resolveSave: (value: Company) => void = () => {};
    mockCompaniesApi.putDefaultExecutionPolicy.mockImplementation(
      () =>
        new Promise<Company>((resolve) => {
          resolveSave = resolve;
        }),
    );

    setInputValue(getPolicyTextarea(container), '{"stages":[]}');
    await flushReact();

    const saveButton = container.querySelector(
      "[data-testid='company-settings-default-execution-policy-save']",
    ) as HTMLButtonElement | null;
    expect(saveButton).toBeTruthy();

    await act(async () => {
      saveButton!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    await flushReact();

    // The save completes. companiesApi.list (the background refetch
    // invalidateQueries schedules) is still hanging -- the company-list
    // cache's defaultExecutionPolicy would still read null without a direct
    // cache patch in onSuccess.
    await act(async () => {
      resolveSave(
        makeCompany({ defaultExecutionPolicy: { stages: [] } as unknown as Company["defaultExecutionPolicy"] }),
      );
    });
    await flushReact();
    await flushReact();
    await flushReact();

    // Before the fix: the draft-sync effect reruns once `dirty` clears,
    // reads the still-null defaultExecutionPolicy out of the (unrefetched)
    // company-list cache, and stomps the textarea back to empty.
    expect(getPolicyTextarea(container).value).toBe('{\n  "stages": []\n}');
  });
});
