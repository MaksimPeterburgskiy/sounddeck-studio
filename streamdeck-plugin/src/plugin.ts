import streamDeck from "@elgato/streamdeck";
import { Connection } from "./connection";
import { PlaySound } from "./actions/playSound";
import { StopAll } from "./actions/stopAll";
import { SwitchBoard } from "./actions/switchBoard";
import { CycleBoards } from "./actions/cycleBoards";
import { ToggleSetting } from "./actions/toggleSetting";

declare const __PLUGIN_VERSION__: string;
const connection = new Connection(__PLUGIN_VERSION__);
streamDeck.actions.registerAction(new PlaySound(connection));
streamDeck.actions.registerAction(new StopAll(connection));
streamDeck.actions.registerAction(new SwitchBoard(connection));
streamDeck.actions.registerAction(new CycleBoards(connection));
streamDeck.actions.registerAction(new ToggleSetting(connection));
process.once("SIGTERM", () => connection.stop());
process.once("SIGINT", () => connection.stop());
await streamDeck.connect();
connection.start();
