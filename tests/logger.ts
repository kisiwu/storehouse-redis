import Logger, { Debug } from '@novice1/logger';

Debug.enable('@storehouse/redis*');

export const logger = Logger.debugger('@storehouse/redis:test');