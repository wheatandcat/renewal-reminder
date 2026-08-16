-- Migration number: 0003 	 2026-08-16T00:00:00.000Z

-- user_agent は INSERT でも SELECT でも使われておらず、常にNULLのため削除する
ALTER TABLE subscriptions DROP COLUMN user_agent;
