// A fake Playwright Page with just enough surface for browser.ts's waits.
//
// Time does not pass on its own here: `waitForTimeout` resolves at once, and a
// network response arrives only when the test calls `respond()`. A helper that
// treats a fixed sleep or an instant query as "the product has finished" is
// therefore caught returning too early — which is the defect #305 describes.

import type { Page } from "playwright";

export interface FakeResponse {
  url: string;
  method?: string;
  status: number;
  body?: unknown;
}

type Waiter = {
  predicate: (response: unknown) => boolean;
  resolve: (response: unknown) => void;
  reject: (error: Error) => void;
};

export class FakePage {
  readonly actions: string[] = [];
  /** Elements currently on the page, by test id or selector. */
  readonly present = new Set<string>();
  /** Visible text, for getByText(). */
  readonly texts = new Set<string>();
  bodyText = "";
  private readonly waiters: Waiter[] = [];
  /** When set, waitFor() on these selectors times out. */
  readonly neverAppears = new Set<string>();

  asPage(): Page {
    return this as unknown as Page;
  }

  async goto(url: string): Promise<null> {
    this.actions.push(`goto ${url}`);
    return null;
  }

  async waitForTimeout(ms: number): Promise<void> {
    this.actions.push(`sleep ${ms}`);
  }

  waitForResponse(predicate: (response: unknown) => boolean, options?: { timeout?: number }): Promise<unknown> {
    this.actions.push(`waitForResponse ${options?.timeout ?? "default"}`);
    return new Promise((resolve, reject) => this.waiters.push({ predicate, resolve, reject }));
  }

  /** Resolves once something is waiting for a response — i.e. the click is armed. */
  async whenWaiting(): Promise<void> {
    for (let i = 0; i < 1000 && this.waiters.length === 0; i += 1) await new Promise((resolve) => setImmediate(resolve));
    if (this.waiters.length === 0) throw new Error(`nothing is waiting for a response; actions: ${this.actions.join(" → ")}`);
  }

  /** Delivers a network response to whoever is waiting for one like it. */
  respond(response: FakeResponse): void {
    const wrapped = {
      url: () => response.url,
      status: () => response.status,
      ok: () => response.status >= 200 && response.status < 300,
      request: () => ({ method: () => response.method ?? "POST" }),
      json: async () => response.body,
    };
    for (const waiter of [...this.waiters]) {
      if (waiter.predicate(wrapped)) {
        this.waiters.splice(this.waiters.indexOf(waiter), 1);
        waiter.resolve(wrapped);
      }
    }
  }

  /** Times out everything still waiting for a response, as Playwright would. */
  timeOutResponses(): void {
    for (const waiter of this.waiters.splice(0)) {
      const error = new Error("Timeout exceeded while waiting for event \"response\"");
      error.name = "TimeoutError";
      waiter.reject(error);
    }
  }

  getByTestId(id: string): FakeLocator {
    return new FakeLocator(this, `testid=${id}`);
  }

  locator(selector: string): FakeLocator {
    return new FakeLocator(this, selector);
  }

  getByText(text: string): FakeLocator {
    return new FakeLocator(this, `text=${text}`);
  }
}

export class FakeLocator {
  private readonly page: FakePage;
  private readonly selector: string;

  constructor(page: FakePage, selector: string) {
    this.page = page;
    this.selector = selector;
  }

  first(): FakeLocator {
    return this;
  }

  async click(): Promise<void> {
    this.page.actions.push(`click ${this.selector}`);
  }

  async fill(value: string): Promise<void> {
    this.page.actions.push(`fill ${this.selector} (${value.length} chars)`);
  }

  async isEnabled(): Promise<boolean> {
    // An instant query, as in Playwright: it answers now and waits for nothing.
    this.page.actions.push(`isEnabled ${this.selector}`);
    return true;
  }

  async count(): Promise<number> {
    this.page.actions.push(`count ${this.selector}`);
    return this.page.present.has(this.selector) ? 1 : 0;
  }

  async waitFor(options?: { state?: string; timeout?: number }): Promise<void> {
    this.page.actions.push(`waitFor ${this.selector} ${options?.state ?? "visible"}`);
    if (this.page.neverAppears.has(this.selector)) {
      const error = new Error(`Timeout ${options?.timeout ?? 30000}ms exceeded waiting for ${this.selector}`);
      error.name = "TimeoutError";
      throw error;
    }
  }

  async innerText(): Promise<string> {
    return this.page.bodyText;
  }
}
