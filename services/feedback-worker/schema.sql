-- CourseHub D1 Database Schema (Zero-Cost Free Tier)
-- 适用于 Cloudflare D1 Free 数据库，用于存储轻量脱敏反馈、错误指纹聚合与限流状态

-- 1. 反馈核心表
CREATE TABLE IF NOT EXISTS feedback (
  id TEXT PRIMARY KEY,
  category TEXT NOT NULL,
  description TEXT NOT NULL,
  reproduction_steps TEXT,
  contact TEXT,
  app_version TEXT NOT NULL,
  os_info TEXT NOT NULL,
  error_fingerprint TEXT,
  diagnostics_summary TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  github_issue_number INTEGER,
  github_issue_url TEXT,
  client_ip TEXT,
  created_at TEXT NOT NULL,
  created_timestamp INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_feedback_fingerprint ON feedback(error_fingerprint);
CREATE INDEX IF NOT EXISTS idx_feedback_created_ts ON feedback(created_timestamp);
CREATE INDEX IF NOT EXISTS idx_feedback_status ON feedback(status);

-- 2. 错误指纹聚合统计表 (Issue 去重与计数)
CREATE TABLE IF NOT EXISTS error_fingerprints (
  fingerprint TEXT NOT NULL,
  category TEXT NOT NULL,
  issue_number INTEGER NOT NULL,
  issue_url TEXT NOT NULL,
  report_count INTEGER NOT NULL DEFAULT 1,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  PRIMARY KEY (fingerprint, category)
);

-- 3. GitHub 同步任务与重试队列
CREATE TABLE IF NOT EXISTS github_sync_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  feedback_id TEXT NOT NULL UNIQUE,
  action TEXT NOT NULL,
  fingerprint TEXT,
  retry_count INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending',
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sync_jobs_status ON github_sync_jobs(status);

-- 4. 持久化全局 IP 限流表 (真正的跨边缘实例频控)
CREATE TABLE IF NOT EXISTS rate_limits (
  key TEXT PRIMARY KEY,
  count INTEGER NOT NULL DEFAULT 1,
  reset_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_rate_limits_reset ON rate_limits(reset_at);
