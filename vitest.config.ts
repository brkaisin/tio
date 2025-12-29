/// <reference types="vitest" />
import { defineConfig } from "vite";

export default defineConfig({
    test: {
        exclude: [],
        include: ["**/*.test.ts"],
        sequence: {
            concurrent: true
        }
    },
    esbuild: {
        target: "ES2022"
    }
});
