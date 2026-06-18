# Daggerheart App

A companion and reference app for the [Daggerheart](https://darringtonpress.com/daggerheart/) tabletop roleplaying game.

## About

Daggerheart App is a digital companion for players and Game Masters running Daggerheart sessions. It aims to make character tracking and session management faster and easier — so you can spend less time flipping pages and more time at the table.

## Features

The app is a mobile-first, single-page companion with five tabs:

- **Campaign** — the table hub: campaign details, your character switcher (including fallen heroes), the party roster at a glance, and a shared session feed you can post to.
- **Combat** — the at-a-glance play surface: tap-to-mark HP / Stress / Hope / Armor, damage thresholds, conditions, and attacks ranked by hit chance and average damage, with a Death's Door flow.
- **Sheet** — a fully editable character sheet: identity, traits, defenses, experiences, class features, downtime project clocks, gold, and inventory. Every change autosaves.
- **Cards** — your domain-card loadout; tap a card for its full rules text.
- **Notes** — start/end a session, keep a private journal, and post moments to the table.

Deeper tools remain available from the in-app **More** menu: the Combat Advisor, the Roll Odds calculator, and the full desktop editor with version history, branches, and PDF print.

## Getting Started

```sh
npm install
node server.js        # serves on http://localhost:4000
```

Set `APP_PASSWORD` in a `.env` file to gate writes (reads stay public); leave it unset for local development. The SQLite database lives in `db/` and seeds a sample campaign on first run.

It also ships as Docker Compose — see the `Makefile` (`make run` / `make deploy`).

## Contributing

Contributions are welcome. Once the project has initial scaffolding in place, a contributing guide will be added here.

## License

Application source code: licence TBD.

Daggerheart game content is property of Darrington Press and is used under the [Daggerheart Community Gaming License](https://darringtonpress.com/daggerheart/). This project is not affiliated with or endorsed by Critical Role or Darrington Press.
