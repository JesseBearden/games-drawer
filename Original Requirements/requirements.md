# Browser artillery tank game requirements

## Game overview

Build a 2D, side-view artillery game inspired by Scorched Earth. A player joins an ongoing arena, drops a squat tank from a helicopter, and aims and fires at other tanks. Combat is real time. Players can fire independently, and a tank has one active shot or volley at a time. The game should feel worthwhile for a short visit and work on desktop and phones.

## Rooms, players, and bots

- Support public rooms and private rooms accessible through an invite link. Cap each room at 10 tank slots total, shared by humans and bots.
- Start with a server-wide cap of 10 public rooms and 10 private rooms. Count rooms that are still in their idle grace period. If a request would create a room above the cap for that type, show “Try again later.” An eligible player can still join an existing room with an available slot.
- When the last human disconnects or leaves, start a 60-second empty-room timer. Bots do not count toward occupancy. A human joining or reconnecting before expiry cancels the timer. At expiry, close the room, free its capacity, and discard its state and tank reservations. This applies to both room types. An expired private room requires a new room and invite.
- Players can join, leave, and rejoin during play. The room continues when its creator leaves. A human can play against bots when nobody else is present.
- Bots appear as normal tanks, fight under the same rules, earn kills and perks, and count as valid kills. Use four active tanks as a minimum target when fewer than four humans are connected. Humans can replace unreserved bots. Bot-controlled tanks reserved for disconnected players still occupy their existing slots and count toward the target.
- When a player leaves, a bot takes control of that tank in place, preserving its position, spawn state, active shot, kills, deaths, and perks. The returning player inherits changes earned or incurred by the bot, including a reset to the starting tier.
- The original player can reclaim their tank for 60 seconds in a public room and for the lifetime of a private room. Both reclaim windows end if the room closes. For the first build, reserve the slot for that reclaim window. After a public reservation expires, a newcomer may replace its bot and receives a fresh tank. Decide later whether to let a private-room owner release a reservation early.
- Suggested starting identity mechanism is a browser session credential, so players can reclaim a tank without an account. For the first playtest, keep bots and the simulation running during the empty-room grace period so reclaiming preserves the existing takeover behavior.

## Controls and combat

| Action | Desktop | Phone |
| --- | --- | --- |
| Adjust turret angle | Left and right arrows | On-screen angle adjusters |
| Adjust launch velocity | Up and down arrows | On-screen power adjusters |
| Fire | Space | Large Fire button |
| Drop from helicopter | Any gameplay key | Any on-screen gameplay button, including the prominent Drop button |
| Move after unlocking movement | A/Z proposed by the designer, with A/D as a playtest alternative | On-screen left and right controls |

- Preserve angle and power between shots while controlling a tank. Try tap for fine adjustments and hold for continuous adjustment on touchscreens.
- Start with a typical flight time of about one second. Tune by hand across close shots and high arcs. Give shells a lifetime or an out-of-bounds rule so a shot always resolves.
- Each room has shared horizontal wind with a speed and a left or right direction. The server applies it to shells in flight, so longer arcs can drift more. Start with steady wind so players can correct their aim between shots. Tune strength and test whether wind should change during a match.
- A direct shell hit kills in one hit unless spawn protection is active. Nearby detonations carve the ground and can cause a lethal fall. There are no tank health bars.
- A spread counts as one firing action and occupies the shot slot until all three shells resolve. Show when the next shot is a spread.
- Tanks start stationary. Movement becomes available through progression.

## Helicopter drops, terrain, and fall deaths

- On first join and after death, approach by helicopter. Randomly choose a left-to-right or right-to-left pass. Any gameplay button press releases the tank at the helicopter’s current position. Consume that press as a drop action. Chat and menu inputs keep their usual behavior. Try an automatic drop near the end of the pass.
- The tank is invulnerable to attacks while carried and during its parachute descent. A direct shell hit on the helicopter resolves the shell and immediately releases the tank from its current position. A forced drop uses the same protected parachute descent as a voluntary drop. Destroying an occupied helicopter awards the shooter one credited kill and one level. Award it once per helicopter and preserve the passenger's lives and progression. The tank still drops under its parachute.
- Start with a small visible parachute to signal protected descent. Remove it on ground contact, then apply the normal landing and slide rules.
- Use procedural, destructible terrain. Start with a maximum settling slope of 30°. On steeper ground the tank slides. It can settle on a gentler patch if it reaches one safely.
- A lethal fall starts at **6 tank heights of vertical drop in a single fall**, configurable on the server. Start measuring when a grounded tank loses its footing, and restart the measurement once the tank settles. A fresh helicopter drop uses the landing and slide rules. Measure any subsequent fall from the point where the tank slides off usable ground, so the normal descent from the helicopter does not consume the fall allowance. Use the squat tank body height as the reference unit.
- If a shot removes a tank's footing and the resulting continuous fall kills it, award the shooter the kill. A bad drop or an unattributed fall is an environmental death. For the first build, credit the shot that initially removes the footing for that continuous fall. If the tank settles and falls again, evaluate the new fall separately.
- Keep the separate 15-second protection from incoming shots after settling, ending immediately when the tank fires. Terrain and bad drops can still cause a fall. Test an inactivity timeout and bot takeover separately.
- Prototype terrain that extends downward as the fight descends. Generate solid ground below the arena and move the camera without changing tank or projectile world positions. A hard refresh can be reconsidered after playtesting. Camera behavior when tanks spread far apart vertically is open.

## Progression and winning

Start each run at zero kills and level zero. Each credited kill increases the run's kill count by one and grants one level by default. Track kills and level separately so a bounty can increase level without inflating the kill count. A run belongs to a tank and persists across human-to-bot handoffs until a progression or match reset. A newcomer receiving a fresh tank starts a new run. Three deaths reset the run and remove its perks. At level 25, earning the extra life changes that run's reset threshold to four deaths, even if the tank already has two deaths. A lethal hit still counts as a death and triggers a fresh drop.

| Level | Perk | Status |
| --- | --- | --- |
| 5 | Shells launch 10% faster. | Starting rule |
| 10 | Unlock slow tank movement. | Starting rule |
| 15 | Every tenth fired shot is a three-shell spread. | Starting rule |
| 20 | Mark where the last shot landed to help correct aim. | Candidate |
| 25 | Gain one extra life. The fourth death resets the run. | Starting rule |
| 30 | The tank explodes on death with a blast that can kill nearby tanks. Try a brief visible warning. | Proposed |
| 35 | Unlock an optional digger round that carves a deeper crater. | Candidate |
| 40 | Increase tank movement speed. | Proposed |
| 45 | Increase spread frequency to every fifth shot. | Starting rule |
| 50 | Win the match, trigger a nuke, and reset terrain and all tanks' progression. | Starting rule |

- **Higher-tier bounty (playtest option).** For a credited enemy tank kill, award max(1, floor(victim's level before death / 5)) total levels. A level-25 tank grants five levels, and a level-40 tank grants eight. Helicopters grant one level regardless of passenger level. Grant every perk threshold crossed, and treat reaching or passing level 50 as a level-50 milestone subject to the normal win rules. Compare against flat one-level awards and track levels gained per kill and time to level 50.
- Consider a small, capped increase in crater size per kill to help high-level tanks clear dirt. Keep regular shell lethality tied to direct hits.
- The level-30 death blast is a distinct source of lethal area damage. Prototype kill credit for the tank that exploded, and decide whether the blast can trigger a win on that tank's final death.
- A level-50 win can be rare. Show the winner before the reset and bring players back in by helicopter afterward. Decide whether a bot can trigger the nuke and how to resolve simultaneous winning kills.
- Show the current level above the tank so opponents can see its perks and bounty potential. Show the actual kill count separately in player stats if bounty mode is active. Expect players to gang up on stronger tanks and test whether that keeps newcomers competitive.
- Decide whether shot cadence starts at unlock or uses a running shot count, and how to transition cadence at level 45.

## Visuals and HUD

- **Tanks.** Use squat side-view silhouettes with clearly visible turrets. Give each active tank a distinct color from a palette that supports 10 simultaneous tanks. Keep the tank's color when control passes to or from a bot. Give the local tank a separate outline or marker so players can identify it without relying on color alone.
- **Camera scale.** Use the [latest desktop concept](https://chatgpt.com/library?file_id=libfile_832c360f283c8191aafe990657c03f71&account_id=personal) as the framing target. Show roughly 50% more world width than the prior zoomed-out ten-tank concept, with smaller tanks and more space to maneuver between firing positions. Treat this as the starting framing and test a farther zoom only if the tanks and kill counts remain readable on phones. Keep tank colors and turret direction readable at that scale.
- **Terrain.** Start with stylized mountain shapes. Use muted background mountains and a solid foreground with a crisp, high-contrast collision edge. Give the playable terrain pronounced elevation changes, including high ridges, intermediate shelves, and deep valleys. Add subtle color bands or shading below the surface for depth. Craters and unsupported tanks should be easy to read at phone sizes. A flat-color foreground remains a viable fallback if the detail competes with gameplay.
- **Upper left.** Show three hearts at the start of a run. Empty one per death. At level 25, add a fourth heart while retaining any hearts already lost.
- **Upper right.** Show numeric turret angle and power. Use a compact readout on phones.
- **Wind.** Use a small windsock with a numeric speed beside it, visually separate from angle and power. The sock extends in the direction the wind pushes shells. If calm wind is supported, show a drooping sock and zero. Give the indicator an accessible label that includes speed and direction.
- **Over each tank.** Try placing its current level just above the tank, with enough clearance for the turret and aiming line. Test below-tank placement if overhead labels overlap or obscure shots.
- **Right side on desktop.** Put room text chat in a collapsible sidebar. On phones, use a Chat button that opens a panel so the default view leaves the terrain and controls visible.
- Make active spawn protection, the ready spread shot, and a pending death blast visually distinct.

## Browser delivery and backend

- Launch as one responsive browser game for desktop and mobile. Make links directly playable in iPhone Safari and Android Chrome, with touch controls and a HUD that does not obscure the arena. Test landscape first. Home-screen installation is optional.
- Start with a single AWS Lightsail instance that supports long-lived secure WebSockets. Keep rooms in memory for the first release. Add persistence if rooms or private reclaim rights need to survive deploys or restarts.
- Use an authoritative Go server over WebSockets for rooms, input, tank and shell simulation, bots, terrain changes, scoring, and reconnects. The browser draws the shared game state and sends player inputs. A single hosted app can serve the game and run the first version. A server restart resets active rooms.
- Keep a versioned WebSocket message contract in the repository. Start with JSON and shared fixtures for inputs, snapshots, and updates. Validate the fixtures in Go and in the browser client so protocol changes stay in sync.
- The server sends a full room snapshot on join or reconnect and incremental state updates during play. Clients render smoothly between snapshots. Send terrain changes incrementally so regular updates stay small.
- Test switching apps, locking the screen, and changing networks on phones. On return, reconnect and reclaim using the room's existing rules, then resync the latest state. The server continues simulating the room and hands a disconnected tank to a bot.

## AWS infrastructure and deployment

- Keep application code, AWS CDK stacks, and CI configuration in the same Git repository. Use CDK to provision the Lightsail instance, CloudWatch log groups and alarms, and applicable networking and access configuration.
- Deploy from Git through CI. On a merge to the main branch, run build and tests, deploy any CDK changes, and release a versioned Go server binary and browser assets tied to the commit. Verify service health after deploying and retain the previous successful build for rollback.
- Use short-lived AWS credentials for CI where the Git provider supports federation. Keep credentials and application secrets out of Git. The Git provider and the mechanism for delivering the release to the Lightsail instance can be selected during implementation.
- An application restart clears in-memory rooms in the first release. Deploy outside scheduled playtests until room persistence is added.

## Room chat and voice

- Offer optional, invite-only room voice in private rooms. Voice follows the player through deaths and respawns. Provide Join voice, self-mute, per-player mute, and a speaking indicator.
- Offer room text chat in public and private rooms, with an option to hide chat. Apply the moderation and audit rules below.
- For voice, use managed WebRTC as the initial approach. The game server can issue a room token after checking private-room membership. The browser requests microphone permission when the player joins voice over HTTPS.

## Text chat moderation and audit logs

- Validate and screen text on the server before broadcasting. Normalize for filtering, apply word and phrase rules that account for common obfuscations, and rate-limit repeated or rapid messages. Reject flagged messages, show the sender a short private explanation, and keep blocked content out of public chat and chat history. If the moderation check fails, reject the submission and tell the sender to retry.
- Log both delivered and blocked submissions for review in a restricted CloudWatch Logs group. Record the original submitted text within the accepted message length, timestamp, room and message IDs, pseudonymous sender ID, outcome, and reason or rule version. Record routine rate-limit events as counts so spam cannot flood the audit log.
- Provide mute and report controls. A report references the message and room for review. A moderator can mute or remove repeat offenders. A filter can miss harassment that depends on context, so use reports and audit review to refine the rules.
- Restrict transcript access to authorized moderators or operators. Keep raw text out of gameplay analytics, metric dimensions, and alert payloads. Tell players that text chat is moderated and logged. Start with a proposed 30-day retention window for raw chat and review it after the playtest. Voice recordings are outside this scope.

## CloudWatch metrics and gameplay analytics

Use server-side structured events in CloudWatch Logs and query gameplay distributions and ratios with Logs Insights. Publish a small set of aggregate CloudWatch metrics for dashboards and alarms. Use low-cardinality metric dimensions such as room type and human or bot controller. Keep room, match, tank, run, player, and shot IDs as log fields for joins and investigation.

### Gameplay dashboard

| Metric | Definition |
| --- | --- |
| Average level at third death | Average the tank's level immediately before its third death since its last progression reset. Record one sample per run, including level-25 tanks that survive the third death. Show sample count and a level distribution alongside the average. |
| Average level at progression reset | Record the level before a death-triggered reset and the death number that caused it. Show third- and fourth-death resets separately. Report nuke or server resets separately. |
| Level-50 frequency | Count tanks reaching 50 once per run. Show reaches per 100 started progression runs and per 100 room-hours with at least one connected human, alongside time to reach 50 and actual nuke wins. Runs still in progress can affect the started-run rate. Split human and bot milestones. |
| Shots per kill | Divide total shots fired by credited direct-hit, terrain-fall, and helicopter kills from those shots over the same reporting window. Count one spread volley as one shot. Show both underlying totals and leave the ratio blank when there are no kills. Track death-blast kills separately. |
| Kill and death breakdown | Count direct-hit, terrain-fall, death-blast, and environmental deaths separately. Track helicopter kills as a separate category without a tank death. Split credited kills by attacker and victim controller type, so human-versus-human and human-versus-bot results are visible. |
| Perk progression | Count the first reach of each perk threshold per run. Show the distribution of run-ending levels and elapsed time to each threshold. |
| Join, reconnect, and reclaim | Track joins, session duration, disconnects, bot handoffs, reclaim attempts and successes. Break down public versus private and desktop versus phone. |

- Emit events for room creation and closure, human occupancy transitions, progression run starts, shots fired, deaths resolved, milestones reached, progression resets, match wins, joins, disconnects, bot handoffs, and reclaim outcomes. Use a stable event ID and server timestamp. Record kill cause, levels awarded, and attacker level before and after the award. Include the current controller type on each event because a tank can change hands mid-run. Capture shooter control type at fire time so a later handoff does not change shot attribution. Record the victim's pre-death level and death ordinal before any reset.
- Log events when they happen and aggregate periodic operational counters. Skip routine per-tick event logging. Start with a proposed 90-day retention window for raw gameplay events and retain periodic aggregates longer if useful for tuning.

### Operations and moderation dashboard

- Track live rooms by type, idle expirations, room creation requests rejected at capacity, human connections, bot count, server tick duration and overruns, WebSocket error and reconnect rates, CPU, memory, outbound bandwidth, and moderation check failures. Monitor log ingestion and report volumes to spot spikes.
- Plot delivered, blocked, and reported message counts and the blocked share of screened messages. Break down blocked reasons with a short, fixed set of categories. Page or notify on sustained server errors or tick overruns and alert when moderation checks repeatedly fail. Tune thresholds after a playtest.
- Verify during the playtest that a blocked message never reaches another client and remains available for authorized review. Confirm that a level-25 tank's third death is logged without resetting it, and that a three-shell spread is counted as one shot.

## Implementation order

1. **Playable prototype.** Build one authoritative arena with desktop and phone controls, up to three bot opponents, helicopter drops, wind, destructible terrain, and direct-hit and fall kills. Use one bounded test map first. Verify that a gameplay button or a direct hit on the helicopter triggers one protected drop and that a helicopter kill awards one kill and one level without taking a life from the passenger. Validate that a shallow crater can displace a tank, a six-body-height fall credits the right shooter, and the latest camera framing works with touch controls.
2. **Multiplayer playtest.** Add public and private rooms, bot handoffs and reclaims, progression, and the first gameplay and server metrics. Test with two human browsers and then one full 10-tank room. Verify reconnecting restores the current state and that neither an active shot nor a tank's progression is lost during handoff. Test the room expiry and capacity limits with short test timers where useful.
3. **Expand from playtest results.** Prototype downward terrain and camera behavior, tune the full perk ladder and the level-50 match reset, then add chat and moderation before enabling public text chat. Private voice can follow independently.

## Decisions to revisit during implementation

- **Terrain and camera.** Use a bounded map to tune shooting and falling first. For downward terrain, decide whose position drives the camera when tanks are far apart vertically and how much of the active arena a phone needs to show.
- **Progression edges.** Decide when the spread counter starts and how it changes at level 45. Before implementing level 50, decide whether bots can trigger the nuke, how simultaneous winners are resolved, and whether a death-blast kill can win on the tank's final death.
- **Controls and balance.** Playtest touch layout, movement keys, shell flight time, wind strength, spawn protection, and fall distance. Suggested values are starting points.
