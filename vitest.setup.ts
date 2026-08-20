import "@testing-library/jest-dom/vitest";
import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";

// Unmount anything a test rendered so DOM state never leaks between tests.
afterEach(() => cleanup());
