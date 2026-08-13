/**
 * Crucible Threat Calculator
 * Adds a Party vs. Adversary threat meter to the Combat Tracker, rating the current encounter's difficulty.
 *
 * Classification: each Combatant's side is determined by its token disposition (Friendly = Party,
 * Hostile = Adversary). If no token is placed, falls back to Actor type ("adversary" vs everything else).
 * Threat value: uses the Actor#threat getter already exposed by the Crucible system for both Heroes and
 * Adversaries, so no modification of system files is required.
 */

const MODULE_ID = "crucible-threat-calculator";

/**
 * Difficulty bands compared against the ratio of (Adversary threat / Party threat).
 * Bands are evaluated in ascending order; the first band whose "ratio" exceeds the computed value applies.
 * "target" is the representative ratio used when a GM picks that band from the dropdown, to compute how
 * much Adversary threat should be scaled up or down to land inside that band.
 */
const DIFFICULTY_BANDS = [
  {id: "trivial", label: "CRUCIBLE_THREAT.DIFFICULTY.Trivial", ratio: 0.6, target: 0.4,
    color: "--color-result-verygood"},
  {id: "easy", label: "CRUCIBLE_THREAT.DIFFICULTY.Easy", ratio: 0.9, target: 0.75, color: "--color-result-good"},
  {id: "moderate", label: "CRUCIBLE_THREAT.DIFFICULTY.Moderate", ratio: 1.3, target: 1.1,
    color: "--color-result-warn"},
  {id: "hard", label: "CRUCIBLE_THREAT.DIFFICULTY.Hard", ratio: 1.8, target: 1.55, color: "--color-result-bad"},
  {id: "deadly", label: "CRUCIBLE_THREAT.DIFFICULTY.Deadly", ratio: Infinity, target: 2.2,
    color: "--color-result-verybad"}
];

/* -------------------------------------------- */
/*  Threat Computation                          */
/* -------------------------------------------- */

/**
 * Compute aggregate Party and Adversary threat for a Combat encounter.
 * @param {Combat} combat
 * @returns {{party: number, adversary: number, ratio: number, band: object|null}}
 */
function computeThreat(combat) {
  const D = CONST.TOKEN_DISPOSITIONS;
  let party = 0;
  let adversary = 0;
  for (const c of combat?.combatants ?? []) {
    const threat = Number(c.actor?.threat) || 0;
    if (!threat) continue;
    const disposition = c.token?.disposition ?? (c.actor?.type === "adversary" ? D.HOSTILE : D.FRIENDLY);
    if (disposition === D.HOSTILE) adversary += threat;
    else if (disposition === D.FRIENDLY) party += threat;
  }
  const ratio = party > 0 ? (adversary / party) : (adversary > 0 ? Infinity : 0);
  const band = adversary > 0 ? DIFFICULTY_BANDS.find(b => ratio < b.ratio) : null;
  return {party, adversary, ratio, band};
}

/* -------------------------------------------- */
/*  Combat Tracker Rendering                    */
/* -------------------------------------------- */

/**
 * Build the <li> markup for each difficulty option in the dropdown menu.
 * @returns {string}
 */
function buildMenuMarkup() {
  return DIFFICULTY_BANDS.map(b => `
    <li>
      <button type="button" class="threat-rating-option" data-band="${b.id}">
        <span class="threat-swatch" style="--rating-color: var(${b.color})"></span>
        ${game.i18n.localize(b.label)}
      </button>
    </li>`).join("");
}

/* -------------------------------------------- */

/**
 * Insert the threat meter markup into a rendered Combat Tracker, wire up the dropdown, then populate
 * current values. GM-only: players see no threat meter at all.
 * @param {Application} app
 */
function onRenderCombatTracker(app) {
  if ((game.system.id !== "crucible") || !game.user.isGM) return;
  const header = app.element?.querySelector(".combat-tracker-header");
  if (!header) return;

  if (!header.querySelector(".threat-meter")) {
    const control = `<div class="threat-rating-control">
          <button type="button" class="threat-rating" aria-haspopup="true" aria-expanded="false">
            <span class="threat-rating-label"></span>
            <i class="fa-solid fa-caret-down"></i>
          </button>
          <ul class="threat-rating-menu">${buildMenuMarkup()}</ul>
        </div>`;
    const markup = `<div class="threat-meter">
      <span class="threat-value threat-party"></span>
      ${control}
      <span class="threat-value threat-adversary"></span>
    </div>`;
    header.insertAdjacentHTML("beforeend", markup);

    const meter = header.querySelector(".threat-meter");
    const button = meter.querySelector("button.threat-rating");
    const menu = meter.querySelector(".threat-rating-menu");
    button.addEventListener("click", event => {
      event.stopPropagation();
      const isOpen = menu.classList.toggle("open");
      button.setAttribute("aria-expanded", String(isOpen));
    });
    menu.addEventListener("click", event => {
      const option = event.target.closest(".threat-rating-option");
      if (!option) return;
      event.stopPropagation();
      menu.classList.remove("open");
      button.setAttribute("aria-expanded", "false");
      applyDifficulty(option.dataset.band, app.viewed ?? game.combat);
    });
  }
  refreshPanel(app);
}

/* -------------------------------------------- */

/**
 * Populate a single Combat Tracker application's threat meter with current values.
 * @param {Application} app
 */
function refreshPanel(app) {
  const meter = app?.element?.querySelector(".threat-meter");
  if (!meter) return;
  const combat = app.viewed ?? game.combat;
  const {party, adversary, band} = computeThreat(combat);
  meter.querySelector(".threat-party").textContent = game.i18n.format("CRUCIBLE_THREAT.Party",
    {threat: Math.round(party)});
  meter.querySelector(".threat-adversary").textContent = game.i18n.format("CRUCIBLE_THREAT.Adversary",
    {threat: Math.round(adversary)});
  meter.querySelector(".threat-rating-label").textContent = band ? game.i18n.localize(band.label) : "—";
  meter.querySelector(".threat-rating").style.setProperty("--rating-color",
    band ? `var(${band.color})` : "var(--color-frame)");
  meter.dataset.tooltip = game.i18n.localize("CRUCIBLE_THREAT.Tooltip");
}

/* -------------------------------------------- */

/**
 * Refresh the threat meter on every rendered Combat Tracker instance (sidebar tab and any popout).
 */
function refreshAllTrackers() {
  if ((game.system.id !== "crucible") || !game.user.isGM) return;
  if (ui.combat?.rendered) refreshPanel(ui.combat);
  if (ui.combat?.popout?.rendered) refreshPanel(ui.combat.popout);
}

/* -------------------------------------------- */
/*  Applying a Target Difficulty                */
/* -------------------------------------------- */

/**
 * Scale hostile Adversary actors up or down so the encounter's Adversary/Party threat ratio lands within
 * the chosen difficulty band. Each Adversary is scaled proportionally to its own current threat. For each
 * one, every rank (Minion/Normal/Elite/Boss) is paired with the Level that best hits that Adversary's
 * target threat at that rank, and the (rank, level) combination with the smallest *normalized* threat
 * error (error relative to that rank's own scaling granularity) wins, with ties broken toward the fewest
 * rank/level changes from where the Adversary already is. Normalizing keeps the comparison fair across
 * ranks - otherwise a fine-grained rank like Minion could always land closer to the target in raw threat
 * points than a coarse rank like Boss, even when both fit their own grid equally well. This keeps a Boss
 * relatively tougher than its Minions, favors nudging Level (fine-grained) over Rank (coarse, only four
 * steps) when both fit similarly well, and avoids moving Level or Rank at all when the current values are
 * already the best fit.
 * @param {string} bandId          The chosen DIFFICULTY_BANDS id
 * @param {Combat} combat          The Combat encounter being adjusted
 */
async function applyDifficulty(bandId, combat) {
  if (!game.user.isGM) return;
  const band = DIFFICULTY_BANDS.find(b => b.id === bandId);
  if (!band) return;

  const {party, adversary: currentAdversary} = computeThreat(combat);
  if (!party) {
    ui.notifications.warn(game.i18n.localize("CRUCIBLE_THREAT.NoPartyWarning"));
    return;
  }

  const D = CONST.TOKEN_DISPOSITIONS;
  const hostiles = (combat?.combatants ?? [])
    .filter(c => {
      const disposition = c.token?.disposition ?? (c.actor?.type === "adversary" ? D.HOSTILE : D.FRIENDLY);
      return (disposition === D.HOSTILE) && (c.actor?.type === "adversary");
    })
    .map(c => c.actor)
    .filter(a => a && (Number(a.threat) > 0));

  if (!hostiles.length) {
    ui.notifications.warn(game.i18n.localize("CRUCIBLE_THREAT.NoAdversariesWarning"));
    return;
  }

  const targetAdversaryThreat = band.target * party;
  const scaleFactor = currentAdversary > 0 ? (targetAdversaryThreat / currentAdversary) : 1;
  const rankIds = Object.keys(SYSTEM.THREAT_RANKS);

  const updates = [];
  for (const actor of hostiles) {
    const currentLevel = actor.system?.advancement?.level ?? 1;
    const currentRank = actor.system?.advancement?.rank ?? "normal";
    const currentThreat = Number(actor.threat) || 0;
    if (!currentThreat) continue;
    const targetThreat = currentThreat * scaleFactor;

    // Find the (rank, level) pairing that best hits this Adversary's target threat.
    // Levels below 1 are outside this heuristic's scope, so candidates are clamped to a minimum of 1.
    let best = null;
    for (const rankId of rankIds) {
      const scaling = SYSTEM.THREAT_RANKS[rankId].scaling || 1;
      const level = Math.max(1, Math.round(targetThreat / scaling));
      const error = Math.abs((level * scaling) - targetThreat);
      const rankSteps = Math.abs(rankIds.indexOf(rankId) - rankIds.indexOf(currentRank));
      const levelSteps = Math.abs(level - currentLevel);
      // Normalize error by this rank's own scaling before comparing across ranks. Raw threat error is
      // always <= scaling/2 (by construction of rounding to the nearest level), which means a fine-grained
      // rank (small scaling) can always land closer to the target in absolute terms than a coarse rank
      // (large scaling), even when both are an equally good fit for their own grid. Dividing by scaling
      // puts every rank's fit quality on the same 0-0.5 scale so that comparison is fair, letting the
      // rank/level-step tie-break actually apply instead of being swamped by that granularity bias.
      const normalizedError = error / scaling;
      const cost = (Math.round(normalizedError * 1000) * 100) + (rankSteps * 25) + levelSteps;
      if (!best || (cost < best.cost)) best = {rankId, level, cost};
    }

    if ((best.rankId !== currentRank) || (best.level !== currentLevel)) {
      updates.push(actor.update({
        "system.advancement.rank": best.rankId,
        "system.advancement.level": best.level
      }, {scrollingText: false}));
    }
  }

  if (!updates.length) {
    ui.notifications.info(game.i18n.localize("CRUCIBLE_THREAT.AlreadyAtTarget"));
    return;
  }

  await Promise.all(updates);
  ui.notifications.info(game.i18n.format("CRUCIBLE_THREAT.AppliedNotify", {band: game.i18n.localize(band.label)}));
}

/* -------------------------------------------- */
/*  Global Listeners                            */
/* -------------------------------------------- */

/**
 * Close any open threat-rating dropdown when the user clicks anywhere outside of it.
 */
document.addEventListener("click", () => {
  for (const menu of document.querySelectorAll(".threat-rating-menu.open")) {
    menu.classList.remove("open");
    menu.previousElementSibling?.setAttribute?.("aria-expanded", "false");
  }
});

/* -------------------------------------------- */
/*  Hooks                                       */
/* -------------------------------------------- */

Hooks.on("renderCombatTracker", onRenderCombatTracker);

for (const hook of ["updateCombat", "updateCombatant", "createCombatant", "deleteCombatant", "updateToken",
  "updateActor"]) {
  Hooks.on(hook, refreshAllTrackers);
}
