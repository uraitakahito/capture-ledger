/**
 * 定期実行の設定。静かな時間と周期の下限。どちらも分で受ける。
 */
import { optional } from "./env.js";

const DEFAULT_QUIET_MINUTES = 10;
const DEFAULT_MIN_INTERVAL_MINUTES = 60;

/** 分の数を読む。数でない値や下限より小さい値は起動で止める (黙って既定に戻さない)。 */
const minutes = (name: string, raw: string, floor: number): number => {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < floor) {
    throw new Error(
      `${name} must be an integer of minutes, at least ${String(floor)}, not "${raw}"`,
    );
  }
  return value;
};

export interface ScheduleSettings {
  quietMinutes: number;
  minIntervalMinutes: number;
}

export const scheduleSettings = (): ScheduleSettings => ({
  // 0 を許すのは、故障を入れて確かめるときに待たずに済むようにするため
  quietMinutes: minutes(
    "CAPTURE_LEDGER_SCHEDULE_QUIET_MINUTES",
    optional("CAPTURE_LEDGER_SCHEDULE_QUIET_MINUTES", String(DEFAULT_QUIET_MINUTES)),
    0,
  ),
  minIntervalMinutes: minutes(
    "CAPTURE_LEDGER_SCHEDULE_MIN_INTERVAL_MINUTES",
    optional("CAPTURE_LEDGER_SCHEDULE_MIN_INTERVAL_MINUTES", String(DEFAULT_MIN_INTERVAL_MINUTES)),
    1,
  ),
});
