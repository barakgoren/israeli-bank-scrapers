import { type Page } from 'puppeteer';
export declare function maskHeadlessUserAgent(page: Page): Promise<void>;
/**
 * Priorities for request interception. The higher the number, the higher the priority.
 * We want to let others to have the ability to override our interception logic therefore we hardcode them.
 */
export declare const interceptionPriorities: {
    abort: number;
    continue: number;
};
