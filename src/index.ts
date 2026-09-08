export { SnipeITContainer } from "./container";
// required for outbound interception
export { ContainerProxy } from "@cloudflare/containers";
import { archiveAndPrune } from "./retention";

const INSTANCE = "primary";

export default {
	fetch(request, env) {
		return env.SNIPEIT.getByName(INSTANCE).fetch(request);
	},

	scheduled(controller, env, ctx) {
		const snipe = env.SNIPEIT.getByName(INSTANCE);
		switch (controller.cron) {
			case "58 23 * * *":
				ctx.waitUntil(snipe.wake());
				break;
			case "30 0 * * *":
				ctx.waitUntil(
					Promise.all([archiveAndPrune(env), snipe.restartIfOutdated()]).then((r) => console.log(...r)),
				);
				break;
		}
	},
} satisfies ExportedHandler<Cloudflare.Env>;
