INSERT INTO draft_comment_revisions (target_key, file, line, side, patch_hash, code, start_code) VALUES ('pr-86f279ce9c29f106-7', 'api.ts', 2, 'RIGHT', 'a62c37a6292e710b2edbaf47665730bd4fe8a5e7d2474f16f719bffd5f627eeb', 'retry(upload);', NULL);
INSERT INTO draft_comment_revisions (target_key, file, line, side, patch_hash, code, start_code) VALUES ('pr-86f279ce9c29f106-7', 'api.ts', 3, 'RIGHT', 'a62c37a6292e710b2edbaf47665730bd4fe8a5e7d2474f16f719bffd5f627eeb', 'send();', 'retry(upload);');
INSERT INTO draft_comment_revisions (target_key, file, line, side, patch_hash, code, start_code) VALUES ('pr-86f279ce9c29f106-7', 'util.ts', 1, 'RIGHT', 'a62c37a6292e710b2edbaf47665730bd4fe8a5e7d2474f16f719bffd5f627eeb', 'export const wait = 100;', 'export const wait = 10;');
INSERT INTO draft_comment_revisions (target_key, file, line, side, patch_hash, code, start_code) VALUES ('pr-86f279ce9c29f106-9', 'api.ts', 2, 'RIGHT', 'a62c37a6292e710b2edbaf47665730bd4fe8a5e7d2474f16f719bffd5f627eeb', 'retry(upload);', NULL);
INSERT INTO drafts (target_key, verdict, body, comments, meta) VALUES ('pr-86f279ce9c29f106-7', 'REQUEST_CHANGES', 'One blocker: errors are dropped.', '[{"file":"api.ts","line":2,"side":"RIGHT","severity":"should-fix","body":"Cap the retries."},{"file":"api.ts","line":3,"side":"RIGHT","startLine":2,"chapterId":"c1","author":"agent","severity":"blocking","body":"This drops the error.\n\n```suggestion\nsend().catch(report);\n```","evidence":"Read api.ts:3 and its callers."},{"file":"util.ts","line":1,"side":"RIGHT","startLine":1,"startSide":"LEFT","introduced":false,"body":"This wait was already too long."}]', '{"bodyAuthor":"agent","suggestedVerdict":"REQUEST_CHANGES","written":{"verdict":null,"comments":"3:abc"},"verdictChosen":true,"unchecked":["The upload tests"]}');
INSERT INTO drafts (target_key, verdict, body, comments, meta) VALUES ('pr-86f279ce9c29f106-9', 'COMMENT', '', '[{"file":"api.ts","line":2,"side":"RIGHT","body":"Use the shared constant."}]', NULL);
INSERT INTO drafts (target_key, verdict, body, comments, meta) VALUES ('ref-a4dccef214f9', 'COMMENT', 'Looks right.', '[]', NULL);
INSERT INTO feedback_fetches (target_key, fetched_at, pr_updated_at) VALUES ('pr-86f279ce9c29f106-7', 1793248255575, 1791999999000);
INSERT INTO feedback_threads (target_key, thread_id, data, resolved_seen_at) VALUES ('pr-86f279ce9c29f106-7', 'PRRT_1', '{"id":"PRRT_1","commentId":11,"reviewId":"PRR_1","path":"api.ts","line":2,"originalLine":1,"startLine":null,"side":"RIGHT","subjectType":"LINE","body":"Why 5?","createdAt":1791999991000,"isResolved":false,"resolvedBy":null,"isOutdated":false,"replies":[{"author":"per","bot":false,"mine":false,"body":"Our SLO, @casey?","createdAt":1791999992000}],"status":"question","replyAt":1791999992000}', NULL);
INSERT INTO feedback_threads (target_key, thread_id, data, resolved_seen_at) VALUES ('pr-86f279ce9c29f106-7', 'PRRT_2', '{"id":"PRRT_2","commentId":12,"reviewId":"PRR_1","path":null,"line":null,"originalLine":null,"startLine":null,"side":null,"subjectType":"FILE","body":"Rename util.ts?","createdAt":1791999993000,"isResolved":true,"resolvedBy":"per","isOutdated":true,"replies":[],"status":"resolved","replyAt":null}', 1791999993000);
INSERT INTO file_views (target_key, file, hash, viewed_at) VALUES ('pr-86f279ce9c29f106-7', 'util.ts', 'h-util', 1792000000002);
INSERT INTO patches (target_key, patch, hash) VALUES ('pr-86f279ce9c29f106-7', 'diff --git a/api.ts b/api.ts
--- a/api.ts
+++ b/api.ts
@@ -1,3 +1,4 @@
-const tries = 3;
+const tries = 5;
+retry(upload);
 send();
 done();
diff --git a/util.ts b/util.ts
--- a/util.ts
+++ b/util.ts
@@ -1,2 +1,2 @@
-export const wait = 10;
+export const wait = 100;
 export {};
', 'a62c37a6292e710b2edbaf47665730bd4fe8a5e7d2474f16f719bffd5f627eeb');
INSERT INTO patches (target_key, patch, hash) VALUES ('pr-86f279ce9c29f106-9', 'diff --git a/api.ts b/api.ts
--- a/api.ts
+++ b/api.ts
@@ -1,3 +1,4 @@
-const tries = 3;
+const tries = 5;
+retry(upload);
 send();
 done();
diff --git a/util.ts b/util.ts
--- a/util.ts
+++ b/util.ts
@@ -1,2 +1,2 @@
-export const wait = 10;
+export const wait = 100;
 export {};
', 'a62c37a6292e710b2edbaf47665730bd4fe8a5e7d2474f16f719bffd5f627eeb');
INSERT INTO patches (target_key, patch, hash) VALUES ('ref-a4dccef214f9', 'diff --git a/api.ts b/api.ts
--- a/api.ts
+++ b/api.ts
@@ -1,3 +1,4 @@
-const tries = 3;
+const tries = 5;
+retry(upload);
 send();
 done();
diff --git a/util.ts b/util.ts
--- a/util.ts
+++ b/util.ts
@@ -1,2 +1,2 @@
-export const wait = 10;
+export const wait = 100;
 export {};
', 'a62c37a6292e710b2edbaf47665730bd4fe8a5e7d2474f16f719bffd5f627eeb');
INSERT INTO reply_drafts (target_key, thread_id, body, author, updated_at) VALUES ('pr-86f279ce9c29f106-7', 'PRRT_1', 'Yes, the upload SLO.', 'agent', 1793248255575);
INSERT INTO review_lifecycle (target_key, state) VALUES ('pr-86f279ce9c29f106-7', '{"prState":"OPEN","ownPr":false,"reviewer":"casey","latestHeadSha":"a1b2c3d4e5f60718293a4b5c6d7e8f9012345678","watchingSince":1792000000000,"pinnedAt":1792000000001}');
INSERT INTO review_lifecycle (target_key, state) VALUES ('pr-86f279ce9c29f106-9', '{"prState":"OPEN","ownPr":true,"sourceThreadId":"thr_main","sourceThreadAt":1792000000011,"sent":{"at":1792000000012,"threadId":"thr_main","title":"Fix login race","comments":[{"file":"api.ts","line":2,"side":"RIGHT","at":1792000000012,"body":"Use the shared constant."}]}}');
INSERT INTO review_lifecycle (target_key, state) VALUES ('ref-a4dccef214f9', '{"name":"Upload retries","sourceThreadId":"thr_local","sourceThreadAt":1792000000021,"approvalSent":{"at":1792000000022,"threadId":"thr_local","title":"Upload retries","revision":"rev-1"}}');
INSERT INTO review_preferences (id, value, revision, knobs) VALUES (1, '{"guideDetail":"standard","guideInstructions":"","assistantInstructions":"","automaticReview":"Review this change for defects a careful senior engineer would block on or want fixed. Precision over recall: a missed nit costs nothing; a wrong comment costs the reviewer''s trust.\n1. Start with read_pr_context: what the PR says it does, linked tickets, the repo''s review rules, CI, and what other reviewers already raised.\n2. Read the whole diff, high-risk chapters first. Before you comment, confirm the problem with read_file (callers, the base version). If you can''t confirm it, don''t comment; ask a question only when the answer decides whether there''s a bug.\n3. Skip style, naming, formatting, anything a linter or CI reports, lockfiles, generated files, and anything an existing GitHub thread already raises.\n4. One issue per add_draft_comment, on the line the fix goes. Start with **Blocking:**, **Should fix:** or **Question:**. Say what fails (input → wrong result), then the fix; when the fix replaces specific lines, add a ```suggestion block. Put how you confirmed it in evidence, with file:line: only what you read or ran.\n5. At most 10 comments; keep the most severe.\n6. Then set_review_summary: 2–5 bullets, blockers first with file:line, and anything you couldn''t check. Suggest APPROVE only if nothing blocks and you read every non-generated file, REQUEST_CHANGES only for a verified blocking issue, otherwise COMMENT.","diffLayout":"split","newFiles":"file","markdownFiles":"source","rereviewShows":"since","guideAgent":null,"assistantAgent":null,"wakeOnReplies":"questions","pushChecks":"off","trackGithubReviews":true,"trackTeamRequests":false,"autoStartRepos":[],"verificationPrompt":"Check whether the author properly addressed each piece of my earlier feedback. Start with list_feedback and read_changes_since_review, and read files with read_file when you need context.\nRecord a verdict with one line of evidence for every item with assess_feedback.\nThen look for new problems the fix commits introduce, and add each as an inline draft comment.\nDraft a reply with draft_thread_reply only on open threads where one adds something: what''s still missing, or a short thanks naming the fixing commit. Keep everything terse.","unattendedAuthors":"members","runRepoChecks":false,"threadListReviews":true}', 1, '{"singleKeyShortcuts":true,"returnToOverview":true,"foldViewedFiles":true,"foldGeneratedFiles":true,"localDiffChanges":true,"sendToThread":true,"openInEditor":true,"reviewCommandInThreads":true,"requirements":true,"codeOwners":false,"ciInCode":true,"commentKeys":true,"removalReasons":true,"moveToSummary":true,"askAboutSelection":true,"approveGuard":true,"approveGuardPace":500,"preExistingFindings":true,"agentCoverage":true,"testWeakening":true,"lockfileDigest":true,"runAutomaticReview":true,"recheckOnNewCommits":true,"digDeeper":true,"checkFailureActions":true,"stopGenerating":true,"mentionsWake":true,"prepareOnReturn":true,"runReReviewCheck":true,"trackReviewedPrs":true,"alertGuides":true,"alertTurns":true,"reviewMd":true,"paletteCommands":true,"unattendedAgents":true}');
INSERT INTO review_snapshots (target_key, head_sha, patch, created_at) VALUES ('pr-86f279ce9c29f106-7', 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678', 'diff --git a/api.ts b/api.ts
--- a/api.ts
+++ b/api.ts
@@ -1,3 +1,4 @@
-const tries = 3;
+const tries = 5;
+retry(upload);
 send();
 done();
diff --git a/util.ts b/util.ts
--- a/util.ts
+++ b/util.ts
@@ -1,2 +1,2 @@
-export const wait = 10;
+export const wait = 100;
 export {};
', 1793248255574);
INSERT INTO reviews (target_key, kind, number, repo, title, author, base, head, git_ref, url, status, created_at, project_id, head_sha, cwd) VALUES ('pr-86f279ce9c29f106-7', 'pr', 7, 'acme/web', 'Retry uploads', 'per', 'main', 'per/retry', NULL, 'https://github.com/acme/web/pull/7', 'ready', 1792000000000, 'p1', 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678', NULL);
INSERT INTO reviews (target_key, kind, number, repo, title, author, base, head, git_ref, url, status, created_at, project_id, head_sha, cwd) VALUES ('pr-86f279ce9c29f106-9', 'pr', 9, 'acme/web', 'Fix login race', 'casey', 'main', 'casey/login', NULL, 'https://github.com/acme/web/pull/9', 'ready', 1792000000010, 'p1', 'b2c3d4e5f60718293a4b5c6d7e8f901234567890', NULL);
INSERT INTO reviews (target_key, kind, number, repo, title, author, base, head, git_ref, url, status, created_at, project_id, head_sha, cwd) VALUES ('ref-a4dccef214f9', 'ref', NULL, NULL, NULL, NULL, NULL, NULL, 'main...feature', NULL, 'ready', 1792000000020, 'p1', 'diff:9f8e7d', '/Users/casey/src/web');
