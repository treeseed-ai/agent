import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  copyFileSync,
  existsSync,
  rmSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { PackageDefinition } from "@treeseed-cordis/sdk";
import {
  ExternalHealthProfilePlugin,
  ExternalHealthHandlerPlugin,
} from "./external-activity-plugin.js";

class ExternalActivityArchives {
  private readonly selected: {
    version: string;
    peerDependencies: Record<string, string>;
  } = JSON.parse(readFileSync("package.json", "utf8"));
  readonly root = mkdtempSync(join(tmpdir(), "external-activity-"));
  readonly archives = join(this.root, "archives");
  readonly fixture = join(this.root, "fixture");
  readonly consumer = join(this.root, "consumer");
  readonly source = resolve("dist/tests/support/external-activity-plugin.js");
  private command(file: string, args: string[], cwd: string): string {
    const result = spawnSync(file, args, {
      cwd,
      encoding: "utf8",
      timeout: 60000,
    });
    assert.equal(result.status, 0, result.stderr.slice(0, 4000));
    return result.stdout;
  }
  async run(): Promise<void> {
    try {
      this.prepare();
      this.command(
        "bun",
        ["pm", "pack", "--destination", this.archives],
        process.cwd(),
      );
      this.command(
        "bun",
        ["pm", "pack", "--destination", this.archives],
        this.fixture,
      );
      this.install();
      this.execute();
    } finally {
      rmSync(this.root, { recursive: true, force: true });
    }
  }
  private prepare(): void {
    mkdirSync(this.archives);
    mkdirSync(join(this.fixture, "dist"), { recursive: true });
    mkdirSync(this.consumer);
    copyFileSync(this.source, join(this.fixture, "dist/plugin.js"));
    copyFileSync(
      resolve("dist/tests/support/external-activity-plugin.d.ts"),
      join(this.fixture, "dist/plugin.d.ts"),
    );
    writeFileSync(
      join(this.fixture, "package.json"),
      JSON.stringify(this.metadata()),
    );
    copyFileSync(
      resolve("dist/tests/support/external-activity-consumer.js"),
      join(this.consumer, "consumer.js"),
    );
    copyFileSync(
      resolve("tests/support/external-activity-consumer.ts"),
      join(this.consumer, "consumer.ts"),
    );
  }
  private metadata(): object {
    return {
      name: "@fixture/cordis-activity-profile",
      version: "1.0.0",
      type: "module",
      exports: {
        ".": { types: "./dist/plugin.d.ts", default: "./dist/plugin.js" },
      },
      files: ["dist"],
      scripts: { postinstall: "touch postinstall-ran" },
      peerDependencies: {
        "@treeseed-cordis/sdk":
          this.selected.peerDependencies["@treeseed-cordis/sdk"],
        zod: "4.6.7",
      },
      cordisPackage: this.projection(),
    };
  }
  private projection(): object {
    return PackageDefinition.define(
      "@fixture/cordis-activity-profile",
      "1.0.0",
      "fixture-health",
      [
        PackageDefinition.export(
          ExternalHealthProfilePlugin,
          "dist/plugin.js",
          "ExternalHealthProfilePlugin",
        ),
        PackageDefinition.export(
          ExternalHealthHandlerPlugin,
          "dist/plugin.js",
          "ExternalHealthHandlerPlugin",
        ),
      ],
    );
  }
  private consumerMetadata(): object {
    return {
      private: true,
      type: "module",
      dependencies: this.consumerDependencies(),
    };
  }
  private consumerDependencies(): object {
    return {
      "@treeseed-cordis/agent": "file:" + join(
        this.archives, "treeseed-cordis-agent-" + this.selected.version + ".tgz",
      ),
      "@treeseed-cordis/sdk": "file:" + resolve("vendor/sdk.tgz"),
      "@treeseed-cordis/deployment": "file:" + resolve("vendor/deployment.tgz"),
      "@fixture/cordis-activity-profile": "file:" + join(
        this.archives, "fixture-cordis-activity-profile-1.0.0.tgz",
      ),
      zod: "4.6.7",
      "@types/node": "24.10.1",
    };
  }
  private install(): void {
    writeFileSync(
      join(this.consumer, "package.json"),
      JSON.stringify(this.consumerMetadata()),
    );
    this.command(
      "bun",
      [
        "install",
        "--ignore-scripts",
        "--cache-dir",
        join(this.root, "cache"),
        "--no-progress",
      ],
      this.consumer,
    );
    assert.equal(
      existsSync(
        join(
          this.consumer,
          "node_modules/@fixture/cordis-activity-profile/postinstall-ran",
        ),
      ),
      false,
    );
  }
  private digest(file: string): string {
    return createHash("sha256").update(readFileSync(file)).digest("hex");
  }
  private execute(): void {
    this.typecheck();
    const archive = join(
      this.archives,
      "fixture-cordis-activity-profile-1.0.0.tgz",
    );
    const output = this.command(
      "node",
      ["consumer.js", this.digest(archive), this.digest(this.source)],
      this.consumer,
    );
    assert.equal(output, "external-activity-archive-ok\n");
    process.stdout.write(output);
  }
  private typecheck(): void {
    this.command(
      "node",
      [
        resolve("node_modules/typescript/bin/tsc"),
        "--noEmit",
        "--strict",
        "--skipLibCheck",
        "--module",
        "NodeNext",
        "--moduleResolution",
        "NodeNext",
        "--target",
        "ES2022",
        "consumer.ts",
      ],
      this.consumer,
    );
  }
}
if (import.meta.main) await new ExternalActivityArchives().run();
