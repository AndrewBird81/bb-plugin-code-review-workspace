INSERT INTO draft_comment_revisions (target_key, file, line, side, patch_hash, code, start_code) VALUES ('br-278040a3ec03412c', 'api.ts', 1, 'RIGHT', '4c7066037813a18910705a742b95f61a530deaa2c3d603854b893f03bb6aeb69', 'const tries = 5;', NULL);
INSERT INTO draft_comment_revisions (target_key, file, line, side, patch_hash, code, start_code) VALUES ('br-278040a3ec03412c', 'api.ts', 2, 'RIGHT', '4c7066037813a18910705a742b95f61a530deaa2c3d603854b893f03bb6aeb69', 'retry(upload);', NULL);
INSERT INTO draft_comment_revisions (target_key, file, line, side, patch_hash, code, start_code) VALUES ('br-278040a3ec03412c', 'api.ts', 3, 'RIGHT', '4c7066037813a18910705a742b95f61a530deaa2c3d603854b893f03bb6aeb69', 'send();', NULL);
INSERT INTO draft_comment_revisions (target_key, file, line, side, patch_hash, code, start_code) VALUES ('br-278040a3ec03412c', 'api.ts', 4, 'RIGHT', '4c7066037813a18910705a742b95f61a530deaa2c3d603854b893f03bb6aeb69', 'done();', NULL);
INSERT INTO draft_comment_revisions (target_key, file, line, side, patch_hash, code, start_code) VALUES ('br-278040a3ec03412c', 'util.ts', 1, 'RIGHT', '4c7066037813a18910705a742b95f61a530deaa2c3d603854b893f03bb6aeb69', 'export const wait = 100;', NULL);
INSERT INTO draft_comment_revisions (target_key, file, line, side, patch_hash, code, start_code) VALUES ('pr-86f279ce9c29f106-12', 'api.ts', 1, 'RIGHT', 'a62c37a6292e710b2edbaf47665730bd4fe8a5e7d2474f16f719bffd5f627eeb', 'const tries = 5;', NULL);
INSERT INTO draft_comment_revisions (target_key, file, line, side, patch_hash, code, start_code) VALUES ('pr-86f279ce9c29f106-12', 'api.ts', 2, 'RIGHT', 'a62c37a6292e710b2edbaf47665730bd4fe8a5e7d2474f16f719bffd5f627eeb', 'retry(upload);', NULL);
INSERT INTO draft_comment_revisions (target_key, file, line, side, patch_hash, code, start_code) VALUES ('pr-86f279ce9c29f106-12', 'api.ts', 3, 'RIGHT', 'a62c37a6292e710b2edbaf47665730bd4fe8a5e7d2474f16f719bffd5f627eeb', 'send();', NULL);
INSERT INTO draft_comment_revisions (target_key, file, line, side, patch_hash, code, start_code) VALUES ('pr-86f279ce9c29f106-12', 'api.ts', 4, 'RIGHT', 'a62c37a6292e710b2edbaf47665730bd4fe8a5e7d2474f16f719bffd5f627eeb', 'done();', NULL);
INSERT INTO draft_comment_revisions (target_key, file, line, side, patch_hash, code, start_code) VALUES ('pr-86f279ce9c29f106-15', 'api.ts', 2, 'RIGHT', 'a62c37a6292e710b2edbaf47665730bd4fe8a5e7d2474f16f719bffd5f627eeb', 'retry(upload);', NULL);
INSERT INTO draft_comment_revisions (target_key, file, line, side, patch_hash, code, start_code) VALUES ('br-9eb956119044eee4', 'api.ts', 2, 'RIGHT', 'a62c37a6292e710b2edbaf47665730bd4fe8a5e7d2474f16f719bffd5f627eeb', 'retry(upload);', NULL);
INSERT INTO draft_comment_revisions (target_key, file, line, side, patch_hash, code, start_code) VALUES ('br-8b39b2ddf5bd0076', 'api.ts', 2, 'RIGHT', 'a62c37a6292e710b2edbaf47665730bd4fe8a5e7d2474f16f719bffd5f627eeb', 'retry(upload);', NULL);
INSERT INTO draft_comment_revisions (target_key, file, line, side, patch_hash, code, start_code) VALUES ('br-0a93e726f82b0934', 'api.ts', 2, 'RIGHT', 'a62c37a6292e710b2edbaf47665730bd4fe8a5e7d2474f16f719bffd5f627eeb', 'retry(upload);', NULL);
INSERT INTO drafts (target_key, verdict, body, comments, meta) VALUES ('br-278040a3ec03412c', 'COMMENT', '', '[{"file":"api.ts","line":1,"side":"RIGHT","severity":"should-fix","body":"Cap the retries at 3.","id":"c1","state":"sent","sendN":2},{"file":"api.ts","line":2,"side":"RIGHT","author":"agent","severity":"blocking","body":"Retry only on a network error.","evidence":"Read api.ts:2.","id":"c2","state":"resolved","sendN":1,"editedBy":"agent","claim":{"outcome":"done","threadId":"thr_sub","at":1793000000101}},{"file":"api.ts","line":3,"side":"RIGHT","body":"Log the failure.","id":"c3","state":"dismissed","sendN":1,"claim":{"outcome":"declined","note":"The caller logs it.","threadId":"thr_main","at":1793000000102}},{"file":"api.ts","line":4,"side":"RIGHT","body":"Say done once.","id":"c4","state":"open","sendN":1,"claim":{"outcome":"done","threadId":null,"at":1793000000103,"inferred":true}},{"file":"util.ts","line":1,"side":"RIGHT","body":"Not sent yet."}]', NULL);
INSERT INTO drafts (target_key, verdict, body, comments, meta) VALUES ('pr-86f279ce9c29f106-12', 'COMMENT', '', '[{"file":"api.ts","line":1,"side":"RIGHT","body":"Open: still to send."},{"file":"api.ts","line":2,"side":"RIGHT","body":"Sent: use the shared constant.","id":"c5","state":"sent","sendN":1},{"file":"api.ts","line":3,"side":"RIGHT","body":"Resolved: log it.","id":"c6","state":"resolved","sendN":1,"claim":{"outcome":"done","commit":"3333333333333333333333333333333333333333","threadId":"thr_fixer","at":1793000000400}},{"file":"api.ts","line":4,"side":"RIGHT","severity":"nit","body":"Dismissed: rename it.","id":"c7","state":"dismissed","sendN":1,"claim":{"outcome":"declined","note":"Out of scope.","threadId":"thr_fixer","at":1793000000401}}]', NULL);
INSERT INTO drafts (target_key, verdict, body, comments, meta) VALUES ('pr-86f279ce9c29f106-15', 'APPROVE', 'Looks good once the retries are counted.', '[{"file":"api.ts","line":2,"side":"RIGHT","severity":"should-fix","body":"Count the retries.","id":"c9","state":"sent","sendN":1}]', '{"verdictChosen":true}');
INSERT INTO drafts (target_key, verdict, body, comments, meta) VALUES ('br-0a93e726f82b0934', 'COMMENT', '', '[{"file":"api.ts","line":2,"side":"RIGHT","body":"Retry downloads too, 21."}]', NULL);
INSERT INTO drafts (target_key, verdict, body, comments, meta) VALUES ('br-9eb956119044eee4', 'COMMENT', '', '[{"file":"api.ts","line":2,"side":"RIGHT","body":"Retry downloads too, 22."}]', NULL);
INSERT INTO drafts (target_key, verdict, body, comments, meta) VALUES ('br-8b39b2ddf5bd0076', 'COMMENT', '', '[{"file":"api.ts","line":2,"side":"RIGHT","body":"Retry downloads too, 23."}]', NULL);
INSERT INTO feedback_fetches (target_key, fetched_at, pr_updated_at) VALUES ('pr-86f279ce9c29f106-12', 1793400923583, 1792999999000);
INSERT INTO feedback_threads (target_key, thread_id, data, resolved_seen_at) VALUES ('pr-86f279ce9c29f106-12', 'PRRT_7', '{"id":"PRRT_7","commentId":71,"reviewId":"PRR_7","path":"util.ts","line":1,"originalLine":1,"startLine":null,"side":"RIGHT","subjectType":"LINE","body":"Why 100?","createdAt":1792999991000,"isResolved":false,"resolvedBy":null,"isOutdated":false,"replies":[],"status":"open","replyAt":null,"author":"per"}', NULL);
INSERT INTO patches (target_key, patch, hash) VALUES ('br-278040a3ec03412c', 'diff --git a/api.ts b/api.ts
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
diff --git a/retry.ts b/retry.ts
new file mode 100644
--- /dev/null
+++ b/retry.ts
@@ -0,0 +1,1 @@
+export const retry = () => {};
', '4c7066037813a18910705a742b95f61a530deaa2c3d603854b893f03bb6aeb69');
INSERT INTO patches (target_key, patch, hash) VALUES ('pr-86f279ce9c29f106-12', 'diff --git a/api.ts b/api.ts
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
INSERT INTO patches (target_key, patch, hash) VALUES ('pr-86f279ce9c29f106-15', 'diff --git a/api.ts b/api.ts
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
INSERT INTO patches (target_key, patch, hash) VALUES ('br-0a93e726f82b0934', 'diff --git a/api.ts b/api.ts
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
INSERT INTO patches (target_key, patch, hash) VALUES ('br-9eb956119044eee4', 'diff --git a/api.ts b/api.ts
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
INSERT INTO patches (target_key, patch, hash) VALUES ('br-8b39b2ddf5bd0076', 'diff --git a/api.ts b/api.ts
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
INSERT INTO review_lifecycle (target_key, state) VALUES ('br-278040a3ec03412c', '{"feature":{"environmentId":"env_fixture","hostId":"host_maxbook","machine":"MaxBook","path":"/Users/casey/src/web","branch":"casey/upload-retries","baseRef":"main","mergeBaseRef":"0123456789abcdef0123456789abcdef01234567","repo":"acme/web","changedFiles":null},"mainThread":{"threadId":"thr_main","environmentId":"env_fixture","origin":"adopted","since":1793000000000},"implementers":[{"threadId":"thr_before","environmentId":"env_fixture","origin":"adopted","since":1792999995000}],"sourceThreadId":"thr_main","sourceThreadAt":1793000000000,"includeHidden":[".env.example"],"flaggedSeen":["config/secrets.yml"],"sends":[{"n":1,"at":1793000000050,"threadId":"thr_main","ids":["c1","c2","c3","c4"],"readyAt":1793000000110,"readyBy":{"from":"main"},"checkedAt":1793000000120},{"n":2,"at":1793000000200,"threadId":"thr_main","ids":["c1"],"queued":"msg_q2","letPush":true}],"sent":{"at":1793000000200,"threadId":"thr_main","title":"Retry uploads","comments":[{"file":"api.ts","line":1,"side":"RIGHT","body":"Cap the retries at 3.","at":1793000000200}]},"fixes":{"sent":1,"reported":0,"inferred":0,"checked":0,"fixed":0},"letPush":true,"push":{"state":"pushed","at":1793000000300,"threadId":"thr_main","repo":"acme/web","head":"casey/upload-retries","sha":"2222222222222222222222222222222222222222"},"remoteHead":{"repo":"acme/web","head":"casey/upload-retries","sha":"2222222222222222222222222222222222222222","at":1793000000301},"activity":[{"at":1793000000050,"text":"Sent 4 comments to Retry uploads","asking":"direct"}]}');
INSERT INTO review_lifecycle (target_key, state) VALUES ('pr-86f279ce9c29f106-12', '{"prState":"OPEN","ownPr":true,"reviewer":"casey","latestHeadSha":"c3d4e5f60718293a4b5c6d7e8f90123456789abc","watchingSince":1793000000000,"feature":{"environmentId":"env_login","hostId":"host_maxbook","machine":"MaxBook","path":"/Users/casey/src/web-login","branch":"casey/login","baseRef":"main","repo":"acme/web","folderGone":true},"mainThread":{"threadId":"thr_fixer","environmentId":"env_fixer","origin":"fresh","since":1793000000300,"branch":"bb/fixes-thr_fixer","fixer":{"sha":"c3d4e5f60718293a4b5c6d7e8f90123456789abc","at":1793000000300}},"implementers":[{"threadId":"thr_login","environmentId":"env_login","origin":"adopted","since":1793000000010}],"sourceThreadId":"thr_fixer","sourceThreadAt":1793000000300,"sends":[{"n":1,"at":1793000000310,"threadId":"thr_fixer","ids":["c5","c6","c7","c8"],"patch":"--- a/api.ts\n+++ b/api.ts\n@@ -3 +3 @@\n-send();\n+send().catch(log);\n","readyAt":1793000000420,"letPush":true,"coverClosed":true}],"threadSends":{"PRRT_7":{"id":"c8","sendN":1,"claim":{"outcome":"done","note":"Matches the SLO.","threadId":"thr_fixer","at":1793000000402}}},"sent":{"at":1793000000310,"threadId":"thr_fixer","title":"Fixes for web#12 · Fix login race","comments":[{"file":"api.ts","line":2,"side":"RIGHT","body":"Sent: use the shared constant.","at":1793000000310}]},"notPushedSeen":{"environmentId":"env_fixer","base":"c3d4e5f60718293a4b5c6d7e8f90123456789abc","at":1793000000430},"keptBranches":[{"branch":"bb/login-thr_login","machine":"MaxBook","path":"/Users/casey/src/web","at":1793000000305}],"prConversation":[{"id":"IC_1","kind":"comment","author":"per","bot":false,"body":"Can this land today?","at":1793000000005,"url":"https://github.com/acme/web/pull/12#issuecomment-1","waiting":true}],"headFork":null,"push":{"state":"flagged","at":1793000000500,"threadId":"thr_fixer","repo":"acme/web","head":"casey/login","flag":"unrequested","remote":"4444444444444444444444444444444444444444","fixer":true},"remoteHead":{"repo":"acme/web","head":"casey/login","sha":"4444444444444444444444444444444444444444","at":1793000000500},"readyToApprove":{"action":"merge","verdict":null,"body":"","comments":[],"headSha":"c3d4e5f60718293a4b5c6d7e8f90123456789abc","merge":{"method":"squash","auto":true,"deleteBranch":true},"token":"tok-merge","from":"thr_orch","fromTitle":"Orchestrate","at":1793000000600},"activity":[{"at":1793000000402,"text":"Posted a reply on util.ts:1","asking":"direct","url":"https://github.com/acme/web/pull/12#discussion_r72"},{"at":1793000000403,"text":"Resolved a thread on util.ts:1","asking":"relayed","from":"thr_orch","fromTitle":"Orchestrate"}]}');
INSERT INTO review_lifecycle (target_key, state) VALUES ('pr-86f279ce9c29f106-15', '{"prState":"OPEN","ownPr":false,"reviewer":"casey","latestHeadSha":"c3d4e5f60718293a4b5c6d7e8f90123456789abc","watchingSince":1793000000000,"sends":[{"n":1,"at":1793000000700,"threadId":"thr_fix15","ids":["c9"]}],"readyToApprove":{"action":"approve","verdict":"APPROVE","body":"Thanks, looks good.","comments":[{"path":"api.ts","line":2,"side":"RIGHT","body":"Nice."}],"headSha":"c3d4e5f60718293a4b5c6d7e8f90123456789abc","token":"tok-approve","from":"thr_orch","fromTitle":"Orchestrate","at":1793000000710},"activity":[{"at":1793000000705,"text":"Drafted 1 comment","asking":"unattended"}]}');
INSERT INTO review_lifecycle (target_key, state) VALUES ('br-0a93e726f82b0934', '{"feature":{"environmentId":"env_21","hostId":"host_maxbook","machine":"MaxBook","path":"/Users/casey/src/web-21","branch":"casey/downloads-21","baseRef":"main","repo":"acme/web","changedFiles":null},"mainThread":{"threadId":"thr_21","environmentId":"env_21","origin":"adopted","since":1793000000030},"startedPrState":"OPEN"}');
INSERT INTO review_lifecycle (target_key, state) VALUES ('br-9eb956119044eee4', '{"feature":{"environmentId":"env_22","hostId":"host_maxbook","machine":"MaxBook","path":"/Users/casey/src/web-22","branch":"casey/downloads-22","baseRef":"main","repo":"acme/web","changedFiles":null,"prReview":"pr-86f279ce9c29f106-22"},"mainThread":{"threadId":"thr_22","environmentId":"env_22","origin":"adopted","since":1793000000030}}');
INSERT INTO review_lifecycle (target_key, state) VALUES ('br-8b39b2ddf5bd0076', '{"feature":{"environmentId":"env_23","hostId":"host_maxbook","machine":"MaxBook","path":"/Users/casey/src/web-23","branch":"casey/downloads-23","baseRef":"main","repo":"acme/web","changedFiles":null,"prReview":"pr-86f279ce9c29f106-23"},"mainThread":{"threadId":"thr_23","environmentId":"env_23","origin":"adopted","since":1793000000030}}');
INSERT INTO review_preferences (id, value, revision, knobs) VALUES (1, '{"guideDetail":"standard","guideInstructions":"","assistantInstructions":"","automaticReview":"Review this change for defects a careful senior engineer would block on or want fixed. Precision over recall: a missed nit costs nothing; a wrong comment costs the reviewer''s trust.\n1. Start with read_pr_context: what the PR says it does, linked tickets, the repo''s review rules, CI, and what other reviewers already raised.\n2. Read the whole diff, high-risk chapters first. Before you comment, confirm the problem with read_file (callers, the base version). If you can''t confirm it, don''t comment; ask a question only when the answer decides whether there''s a bug.\n3. Skip style, naming, formatting, anything a linter or CI reports, lockfiles, generated files, and anything an existing GitHub thread already raises.\n4. One issue per add_draft_comment, on the line the fix goes. Start with **Blocking:**, **Should fix:** or **Question:**. Say what fails (input → wrong result), then the fix; when the fix replaces specific lines, add a ```suggestion block. Put how you confirmed it in evidence, with file:line: only what you read or ran.\n5. At most 10 comments; keep the most severe.\n6. Then set_review_summary: 2–5 bullets, blockers first with file:line, and anything you couldn''t check. Suggest APPROVE only if nothing blocks and you read every non-generated file, REQUEST_CHANGES only for a verified blocking issue, otherwise COMMENT.","diffLayout":"split","newFiles":"file","markdownFiles":"source","rereviewShows":"since","guideAgent":null,"assistantAgent":null,"wakeOnReplies":"questions","pushChecks":"off","trackGithubReviews":true,"trackTeamRequests":false,"autoStartRepos":[],"verificationPrompt":"Check whether the author properly addressed each piece of my earlier feedback. Start with list_feedback and read_changes_since_review, and read files with read_file when you need context.\nRecord a verdict with one line of evidence for every item with assess_feedback.\nThen look for new problems the fix commits introduce, and add each as an inline draft comment.\nDraft a reply with draft_thread_reply only on open threads where one adds something: what''s still missing, or a short thanks naming the fixing commit. Keep everything terse.","unattendedAuthors":"members","runRepoChecks":false,"threadListReviews":true}', 1, '{"singleKeyShortcuts":true,"returnToOverview":true,"foldViewedFiles":true,"foldGeneratedFiles":true,"localDiffChanges":true,"sendToThread":true,"openInEditor":true,"reviewCommandInThreads":true,"requirements":true,"codeOwners":true,"ciInCode":true,"commentKeys":true,"removalReasons":true,"moveToSummary":true,"askAboutSelection":true,"approveGuard":true,"approveGuardPace":500,"preExistingFindings":true,"agentCoverage":true,"testWeakening":true,"lockfileDigest":true,"runAutomaticReview":true,"recheckOnNewCommits":true,"digDeeper":true,"checkFailureActions":true,"stopGenerating":true,"mentionsWake":true,"prepareOnReturn":true,"runReReviewCheck":true,"trackReviewedPrs":true,"alertGuides":true,"alertTurns":true,"reviewMd":true,"paletteCommands":true,"unattendedAgents":true,"reviewAgentActs":false,"reviewChangesLine":false,"trackOwnPrs":false}');
INSERT INTO review_snapshots (target_key, head_sha, patch, created_at) VALUES ('br-278040a3ec03412c', 'diff:a62c37a6292e710b2edbaf47665730bd4fe8a5e7d2474f16f719bffd5f627eeb:files', '{"revisions":{"api.ts":"rev-api-279","util.ts":"rev-util"},"hidden":[{"path":".env.local","reason":"secret"}]}', 1793400923573);
INSERT INTO review_snapshots (target_key, head_sha, patch, created_at) VALUES ('br-278040a3ec03412c', 'send:1', 'diff --git a/api.ts b/api.ts
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
', 1793400923575);
INSERT INTO review_snapshots (target_key, head_sha, patch, created_at) VALUES ('br-278040a3ec03412c', 'send:1:files', '{"revisions":{"api.ts":"rev-api-279","util.ts":"rev-util"},"hidden":[{"path":".env.local","reason":"secret"}]}', 1793400923576);
INSERT INTO review_snapshots (target_key, head_sha, patch, created_at) VALUES ('br-278040a3ec03412c', 'diff:4c7066037813a18910705a742b95f61a530deaa2c3d603854b893f03bb6aeb69:files', '{"revisions":{"api.ts":"rev-api-410","util.ts":"rev-util"},"hidden":[{"path":".env.local","reason":"secret"}]}', 1793400923578);
INSERT INTO review_snapshots (target_key, head_sha, patch, created_at) VALUES ('br-278040a3ec03412c', 'send:2', 'diff --git a/api.ts b/api.ts
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
diff --git a/retry.ts b/retry.ts
new file mode 100644
--- /dev/null
+++ b/retry.ts
@@ -0,0 +1,1 @@
+export const retry = () => {};
', 1793400923579);
INSERT INTO review_snapshots (target_key, head_sha, patch, created_at) VALUES ('br-278040a3ec03412c', 'send:2:files', '{"revisions":{"api.ts":"rev-api-410","util.ts":"rev-util"},"hidden":[{"path":".env.local","reason":"secret"}]}', 1793400923579);
INSERT INTO review_snapshots (target_key, head_sha, patch, created_at) VALUES ('pr-86f279ce9c29f106-12', 'c3d4e5f60718293a4b5c6d7e8f90123456789abc', 'diff --git a/api.ts b/api.ts
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
', 1793400923580);
INSERT INTO review_snapshots (target_key, head_sha, patch, created_at) VALUES ('pr-86f279ce9c29f106-12', 'send:1', 'diff --git a/api.ts b/api.ts
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
', 1793400923582);
INSERT INTO review_snapshots (target_key, head_sha, patch, created_at) VALUES ('pr-86f279ce9c29f106-12', 'not-pushed:files', '{"revisions":{"api.ts":"rev-api-279","util.ts":"rev-util"},"hidden":[{"path":".env.local","reason":"secret"}]}', 1793400923582);
INSERT INTO review_snapshots (target_key, head_sha, patch, created_at) VALUES ('pr-86f279ce9c29f106-15', 'c3d4e5f60718293a4b5c6d7e8f90123456789abc', 'diff --git a/api.ts b/api.ts
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
', 1793400923584);
INSERT INTO review_snapshots (target_key, head_sha, patch, created_at) VALUES ('pr-86f279ce9c29f106-15', 'send:1', 'diff --git a/api.ts b/api.ts
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
', 1793400923585);
INSERT INTO review_snapshots (target_key, head_sha, patch, created_at) VALUES ('br-0a93e726f82b0934', 'c3d4e5f60718293a4b5c6d7e8f90123456789abc', 'diff --git a/api.ts b/api.ts
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
', 1793400923591);
INSERT INTO reviewer_notes (target_key, body, revision) VALUES ('pr-86f279ce9c29f106-23', 'Mine: check the timeouts.', 1);
INSERT INTO reviews (target_key, kind, number, repo, title, author, base, head, git_ref, url, status, created_at, project_id, head_sha, cwd) VALUES ('br-278040a3ec03412c', 'ref', NULL, NULL, 'Retry uploads', NULL, NULL, NULL, 'casey/upload-retries', NULL, 'ready', 1793000000000, 'p1', NULL, NULL);
INSERT INTO reviews (target_key, kind, number, repo, title, author, base, head, git_ref, url, status, created_at, project_id, head_sha, cwd) VALUES ('pr-86f279ce9c29f106-12', 'pr', 12, 'acme/web', 'Fix login race', 'casey', 'main', 'casey/login', 'main...casey/login', 'https://github.com/acme/web/pull/12', 'ready', 1793000000010, 'p1', 'c3d4e5f60718293a4b5c6d7e8f90123456789abc', NULL);
INSERT INTO reviews (target_key, kind, number, repo, title, author, base, head, git_ref, url, status, created_at, project_id, head_sha, cwd) VALUES ('pr-86f279ce9c29f106-15', 'pr', 15, 'acme/web', 'Add upload metrics', 'per', 'main', 'per/metrics', NULL, 'https://github.com/acme/web/pull/15', 'ready', 1793000000020, 'p1', 'c3d4e5f60718293a4b5c6d7e8f90123456789abc', NULL);
INSERT INTO reviews (target_key, kind, number, repo, title, author, base, head, git_ref, url, status, created_at, project_id, head_sha, cwd) VALUES ('br-0a93e726f82b0934', 'pr', 21, 'acme/web', 'Retry downloads 21', 'casey', 'main', 'casey/downloads-21', 'main...casey/downloads-21', 'https://github.com/acme/web/pull/21', 'ready', 1793000000051, 'p1', 'c3d4e5f60718293a4b5c6d7e8f90123456789abc', NULL);
INSERT INTO reviews (target_key, kind, number, repo, title, author, base, head, git_ref, url, status, created_at, project_id, head_sha, cwd) VALUES ('pr-86f279ce9c29f106-22', 'pr', 22, 'acme/web', 'Retry downloads 22', 'casey', NULL, NULL, NULL, 'https://github.com/acme/web/pull/22', 'tracked', 1793000000025, 'p1', NULL, NULL);
INSERT INTO reviews (target_key, kind, number, repo, title, author, base, head, git_ref, url, status, created_at, project_id, head_sha, cwd) VALUES ('br-9eb956119044eee4', 'ref', NULL, NULL, 'Retry downloads 22', NULL, NULL, NULL, 'casey/downloads-22', NULL, 'ready', 1793000000052, 'p1', NULL, NULL);
INSERT INTO reviews (target_key, kind, number, repo, title, author, base, head, git_ref, url, status, created_at, project_id, head_sha, cwd) VALUES ('pr-86f279ce9c29f106-23', 'pr', 23, 'acme/web', 'Retry downloads 23', 'casey', NULL, NULL, NULL, 'https://github.com/acme/web/pull/23', 'tracked', 1793000000025, 'p1', NULL, NULL);
INSERT INTO reviews (target_key, kind, number, repo, title, author, base, head, git_ref, url, status, created_at, project_id, head_sha, cwd) VALUES ('br-8b39b2ddf5bd0076', 'ref', NULL, NULL, 'Retry downloads 23', NULL, NULL, NULL, 'casey/downloads-23', NULL, 'ready', 1793000000053, 'p1', NULL, NULL);
