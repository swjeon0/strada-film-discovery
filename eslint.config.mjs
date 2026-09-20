import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
  {
    files: ["components/ui/**/*.{ts,tsx}"],
    rules: {
      // These files are vendored verbatim from shadcn@4.17.0. Keep the
      // registry source intact while applying the stricter rules to Site code.
      "@typescript-eslint/no-unused-vars": "off",
      "react-hooks/purity": "off",
      "react-hooks/set-state-in-effect": "off",
    },
  },
  {
    files: [
      "app/page.tsx",
      "components/film-drawer.tsx",
      "components/film-search.tsx",
    ],
    rules: {
      // These effects bridge browser storage, cancellable fetches and WebMCP.
      // Their state transitions are intentional synchronization boundaries.
      "react-hooks/purity": "off",
      "react-hooks/refs": "off",
      "react-hooks/set-state-in-effect": "off",
    },
  },
  {
    files: ["app/page.tsx", "components/film-poster.tsx"],
    rules: {
      // Poster URLs are discovered at runtime and deliberately fall back through
      // the image proxy on load failure; next/image cannot preserve that flow.
      "@next/next/no-img-element": "off",
    },
  },
]);

export default eslintConfig;
