// What the review agent is told of everything it drafts that posts to GitHub: comments, the summary, a re-review's
// suggested summary and its replies. The PR's author reads those, and never the guide.

/** The guide is the reviewer's and the agent's: what posts never mentions it, though a problem it pointed to is still raised. */
export const AUTHOR_NEVER_SEES_GUIDE = "The PR's author reads the comments, replies and summary on GitHub and never sees the guide: don't mention it, its chapters, Start here or risk levels, or say it flagged something. A problem it pointed you to that you verify is a comment on its own terms, with your evidence; a spot it flagged that holds up needs no mention, so tell the reviewer in chat.";

/** A summary raises nothing the reviewer didn't meet in the code. */
export const LINE_COMMENTS_FIRST = "Raise every finding about a line as a line comment with add_draft_comment first, so the reviewer meets it in the code; the summary adds none of its own, and doesn't list what you checked and found fine.";
