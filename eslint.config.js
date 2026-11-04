import js from "@eslint/js";
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";

export default tseslint.config(
  {
    ignores: [
      "dist/**",
      "node_modules/**",
      "src/rpc/generated/**",
      // docs-site is a separate workspace package with its own tsconfig and Astro
      // types; linting it from here fails on generated .astro/ modules that
      // the root tsconfig cannot see.
      "docs-site/**",
      // Upstream source, vendored as a submodule. It has its own lint setup;
      // linting it from here just reports on somebody else's code.
      ".upstream/**",
      "coverage/**",
      "*.config.js",
      "*.config.cjs",
      "*.config.mjs",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    files: ["test/**/*.ts"],
    rules: {
      "@typescript-eslint/no-non-null-assertion": "off",
    },
  },
  {
    // Forbid the two-step cast (`x as unknown as T`).
    //
    // Routing through `unknown` lets a value claim any type at all, which is
    // the same as telling the type checker to be quiet. Against a *generated*
    // type that is worse than it sounds: the generated type is the copy of the
    // contract, so casting to it discards the only thing that checks the
    // contract is being kept. BrowserHive's e2e suite sent OpenAPI-era bodies
    // over a protobuf wire for exactly this reason.
    //
    // Scoped to src/rpc/**: the two casts elsewhere are mocks (`{ query } as
    // unknown as Pool`), and building a fake is not the dangerous case —
    // disguising a real value is.
    files: ["src/rpc/**/*.ts"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector: 'TSAsExpression > TSAsExpression[typeAnnotation.type="TSUnknownKeyword"]',
          message:
            "`as unknown as T` bypasses the type checker. Build the right type, or if this is a mock, disable the rule here with a reason.",
        },
      ],
    },
  },
  {
    // Keep src from importing the repo tools (src/tools/).
    //
    // The tools are left out of the production build (tsconfig.build.json), but tsc follows
    // imports: a src module importing a tool would put that tool in the production dist and
    // the image. An editor's auto-import is enough to do it, so the linter refuses it.
    files: ["src/**/*.ts"],
    ignores: ["src/tools/**"],
    rules: {
      "@typescript-eslint/no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              regex: "(^|/)tools/",
              message:
                "src must not import the repo tools (src/tools/); they stay out of the production build.",
            },
          ],
        },
      ],
    },
  },
  {
    // Tools read env through config/read-env.js, not config/env.js.
    //
    // Importing env.ts runs guardEnv(), which exits on any of the API's variables set to the
    // empty string — a tool would stop over a variable it never reads. Type-only imports are
    // erased, so they are allowed.
    files: ["src/tools/**/*.ts"],
    rules: {
      "@typescript-eslint/no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              regex: "(^|/)config/env\\.js$",
              allowTypeImports: true,
              message:
                "Tools import config/read-env.js (importing env.ts runs guardEnv as a side effect).",
            },
          ],
        },
      ],
    },
  },
  prettier,
);
