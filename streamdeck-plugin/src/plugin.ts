import streamDeck from "@elgato/streamdeck";
import { launchApp } from "./launch";
import { Connection } from "./connection";
import { PlaySound } from "./actions/playSound";
import { StopAll } from "./actions/stopAll";
import { SwitchBoard } from "./actions/switchBoard";
import { CycleBoards } from "./actions/cycleBoards";
import { ToggleSetting } from "./actions/toggleSetting";

declare const __PLUGIN_VERSION__: string;
const connection = new Connection(__PLUGIN_VERSION__, {
  launch(appPath) {
    try {
      launchApp(appPath, process.platform, undefined, (error) => streamDeck.logger.error("SoundDeck launch failed", error));
    } catch (error) { streamDeck.logger.error("SoundDeck launch rejected", error); }
  },
});
let lastStatus = connection.status;
connection.subscribe(() => {
  if (connection.status === lastStatus) return;
  lastStatus = connection.status;
  streamDeck.logger.info(`SoundDeck connection: ${lastStatus}`);
});
streamDeck.actions.registerAction(new PlaySound(connection));
streamDeck.actions.registerAction(new StopAll(connection));
streamDeck.actions.registerAction(new SwitchBoard(connection));
streamDeck.actions.registerAction(new CycleBoards(connection));
streamDeck.actions.registerAction(new ToggleSetting(connection));
await streamDeck.connect();
streamDeck.logger.info(`SoundDeck plugin ${__PLUGIN_VERSION__} started`);
connection.start();
