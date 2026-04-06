import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { COMMANDS } from "./src/commands.js";
import { LiteCodexController } from "./src/controller.js";
import { INTERACTIVE_NAMESPACE } from "./src/types.js";

const plugin = {
  id: "openclaw-codex-app-server-lite",
  name: "OpenClaw Codex App Server Lite",
  description: "Minimal Telegram and Feishu Codex App Server binding plugin.",
  register(api: OpenClawPluginApi) {
    const controller = new LiteCodexController(api);

    api.registerService(controller.createService());

    const bindingResolvedHook = (
      api as OpenClawPluginApi & {
        onConversationBindingResolved?: OpenClawPluginApi["onConversationBindingResolved"];
      }
    ).onConversationBindingResolved;
    if (typeof bindingResolvedHook === "function") {
      bindingResolvedHook(async (event) => {
        await controller.handleConversationBindingResolved(event);
      });
    }

    api.on("inbound_claim", async (event) => {
      return await controller.handleInboundClaim(event);
    });

    api.on("before_dispatch", async (event, ctx) => {
      return await controller.handleBeforeDispatch(event, ctx);
    });

    api.registerInteractiveHandler({
      channel: "telegram",
      namespace: INTERACTIVE_NAMESPACE,
      handler: async (ctx) => {
        await controller.handleTelegramInteractive(ctx);
        return { handled: true };
      },
    });

    for (const [name, description] of COMMANDS) {
      api.registerCommand({
        name,
        description,
        acceptsArgs: true,
        handler: async (ctx) => {
          return await controller.handleCommand(name, ctx);
        },
      });
    }
  },
};

export default plugin;
