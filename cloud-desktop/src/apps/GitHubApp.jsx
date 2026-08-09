import { useState } from "react";
import { ArrowSquareOut, CheckCircle, GitBranch, GitPullRequest, GithubLogo, WarningCircle } from "@phosphor-icons/react";
import { githubFixture } from "../fixtures/data.js";

export function GitHubApp({ onFixtureNotice }) {
  const [section, setSection] = useState("repositories");
  return (
    <div className="app-view github-app" data-testid="github-app">
      <aside className="github-sidebar">
        <div className="github-account"><GithubLogo size={28} weight="fill" /><span><strong>{githubFixture.account}</strong><small>{githubFixture.status}</small></span></div>
        {["repositories", "pull requests", "activity"].map((item) => <button key={item} className={section === item ? "is-selected" : ""} onClick={() => setSection(item)}>{item === "repositories" ? <GitBranch /> : item === "pull requests" ? <GitPullRequest /> : <CheckCircle />}<span>{item}</span></button>)}
        <button className="github-manage" onClick={() => onFixtureNotice("GitHub connection unavailable", "OAuth and GitHub API access are deliberately disabled in C1.")}><ArrowSquareOut /> Manage connection</button>
      </aside>
      <section className="github-main">
        <header><span className="eyebrow">Fixture GitHub</span><h2>{section}</h2></header>
        {section === "repositories" && <div className="repository-list">{githubFixture.repositories.map((repo) => <button key={repo.name} onClick={() => onFixtureNotice(repo.name, `Fixture repository on ${repo.branch}. No GitHub request was made.`)}><div className="repo-title"><GitBranch /><strong>{repo.name}</strong><span>{repo.visibility}</span></div><div className="repo-meta"><span>{repo.branch}</span><span className={repo.status === "Up to date" ? "state-good" : "state-warning"}>{repo.status === "Up to date" ? <CheckCircle /> : <WarningCircle />}{repo.status}</span><span>{repo.updated}</span></div></button>)}</div>}
        {section === "pull requests" && <div className="pull-request-list">{githubFixture.pullRequests.map((request) => <button key={request.id}><GitPullRequest /><span><strong>{request.title}</strong><small>{request.repo} · #{request.id}</small></span><span className="state-good">{request.status}</span></button>)}</div>}
        {section === "activity" && <div className="activity-list">{githubFixture.activity.map((activity) => <div key={activity}><CheckCircle /><span>{activity}</span><time>Fixture history</time></div>)}</div>}
      </section>
    </div>
  );
}
