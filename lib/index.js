/**
 * reasonix-token-hud — host half.
 *
 * Registers one client-visible session projection, `usageMeter`, next to the
 * token-meter units the shell already folds. `usageMeter` keeps the same
 * replacement semantics as `tokenUsage` but splits the totals by
 * provider/model and by DeepSeek peak/off-peak tier, so the browser can price
 * a session that crossed the peak boundary exactly instead of pricing every
 * token at "now". The fold lives in ./fold.js.
 *
 * The projection is optional composition: without `sessionProjections` the
 * plugin simply contributes nothing and the client falls back to the built-in
 * `tokenUsage` totals.
 */
import { applyEvent, createView, initialState } from "./fold.js";

/** Cordis plugin name. */
export const name = "reasonix-token-hud";

/** The projection key the client reads through `useProjection`. */
const KEY = "usageMeter";

/** Bump together with any change to the serialized state shape. */
const STATE_VERSION = 1;

/**
 * The projection registry only ever calls `.parse`, on cached state and on the
 * view. The fold is already total and JSON-shaped, so a pass-through schema is
 * enough and keeps this package dependency-free.
 */
const passThrough = { parse: (value) => value };

/**
 * Register the projection whenever the projection registry is composed.
 * @param ctx - Host root context.
 */
export function apply(ctx) {
  ctx.inject(["sessionProjections"], (scoped) => {
    scoped.effect(
      () =>
        scoped.sessionProjections.register({
          key: KEY,
          stateVersion: STATE_VERSION,
          stateSchema: passThrough,
          init: (header) => initialState(header),
          apply: (state, event) => applyEvent(state, event),
          wire: {
            viewSchema: passThrough,
            view: createView(),
          },
        }),
      "reasonix-token-hud: usageMeter projection",
    );
  });
}
