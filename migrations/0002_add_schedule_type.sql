-- Migration number: 0002 	 2026-07-18T00:00:00.000Z

ALTER TABLE schedules ADD COLUMN type TEXT NOT NULL DEFAULT 'start';
