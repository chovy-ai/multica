-- Running background tasks, so lists show work that outlives its turn.
ALTER TABLE conversation ADD COLUMN background_tasks INTEGER NOT NULL DEFAULT 0;
