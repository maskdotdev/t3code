import { type ProjectId } from "@t3tools/contracts";
import {
  compareRankedSearchMatches,
  normalizeNamePathSearchQuery,
  scoreNormalizedNamePathSearchTarget,
} from "@t3tools/shared/search";
import { CornerDownLeftIcon, SearchIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { cn } from "~/lib/utils";
import type { Project } from "~/types";
import ProjectFavicon from "./ProjectFavicon";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "./ui/dialog";
import { Input } from "./ui/input";
import { InputGroup, InputGroupAddon } from "./ui/input-group";
import { Kbd } from "./ui/kbd";

interface ProjectThreadPickerDialogProps {
  open: boolean;
  projects: Project[];
  activeProjectId: ProjectId | null;
  shortcutLabel: string | null;
  onOpenChange: (open: boolean) => void;
  onSelectProject: (projectId: ProjectId) => Promise<void> | void;
}

interface SearchableProject {
  project: Project;
  normalizedName: string;
  normalizedPath: string;
}

function rankProjects(
  searchableProjects: SearchableProject[],
  rawQuery: string,
): Project[] {
  const query = normalizeNamePathSearchQuery(rawQuery);
  if (query.length === 0) {
    return searchableProjects.map(({ project }) => project);
  }

  return searchableProjects
    .flatMap((searchableProject) => {
      const score = scoreNormalizedNamePathSearchTarget(
        {
          normalizedName: searchableProject.normalizedName,
          normalizedPath: searchableProject.normalizedPath,
        },
        query,
      );
      if (score === null) {
        return [];
      }

      return [{ item: searchableProject, score }] as const;
    })
    .toSorted((left, right) => {
      return compareRankedSearchMatches(left, right, (leftItem, rightItem) => {
        const byName = leftItem.project.name.localeCompare(rightItem.project.name);
        if (byName !== 0) {
          return byName;
        }
        return leftItem.project.cwd.localeCompare(rightItem.project.cwd);
      });
    })
    .map(({ item }) => item.project);
}

export default function ProjectThreadPickerDialog(props: ProjectThreadPickerDialogProps) {
  const { activeProjectId, onOpenChange, onSelectProject, open, projects, shortcutLabel } = props;
  const [query, setQuery] = useState("");
  const wasOpenRef = useRef(open);
  const lastQueryRef = useRef(query);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const searchableProjects = useMemo(
    () =>
      projects.map((project) => ({
        project,
        normalizedName: project.name.toLowerCase(),
        normalizedPath: project.cwd.toLowerCase(),
      })),
    [projects],
  );
  const filteredProjects = useMemo(
    () => rankProjects(searchableProjects, query),
    [query, searchableProjects],
  );
  const [activeResultProjectId, setActiveResultProjectId] = useState<ProjectId | null>(
    activeProjectId,
  );

  useEffect(() => {
    if (open && !wasOpenRef.current) {
      setQuery("");
      setActiveResultProjectId(activeProjectId ?? projects[0]?.id ?? null);
      // Auto-focus search input when dialog opens
      queueMicrotask(() => {
        inputRef.current?.focus();
      });
    }
    if (!open && wasOpenRef.current) {
      setQuery("");
    }
    wasOpenRef.current = open;
  }, [activeProjectId, open, projects]);

  useEffect(() => {
    if (!open) return;
    const queryChanged = query !== lastQueryRef.current;
    if (
      !queryChanged &&
      activeResultProjectId &&
      filteredProjects.some((project) => project.id === activeResultProjectId)
    ) {
      lastQueryRef.current = query;
      return;
    }
    lastQueryRef.current = query;
    setActiveResultProjectId(filteredProjects[0]?.id ?? null);
  }, [activeResultProjectId, filteredProjects, open, query]);

  const moveActiveSelection = useCallback(
    (direction: 1 | -1) => {
      if (filteredProjects.length === 0) return;
      const currentIndex = filteredProjects.findIndex(
        (project) => project.id === activeResultProjectId,
      );
      const nextIndex =
        currentIndex < 0
          ? 0
          : (currentIndex + direction + filteredProjects.length) % filteredProjects.length;
      setActiveResultProjectId(filteredProjects[nextIndex]?.id ?? null);
    },
    [activeResultProjectId, filteredProjects],
  );

  const handleSelectProject = useCallback(
    async (projectId: ProjectId) => {
      onOpenChange(false);
      await onSelectProject(projectId);
    },
    [onOpenChange, onSelectProject],
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-lg">
        <DialogHeader>
          <DialogTitle>New Thread</DialogTitle>
          <DialogDescription>
            Choose a project to create a new thread in.
            {shortcutLabel ? (
              <>
                {" "}
                Press <Kbd>{shortcutLabel}</Kbd> to open this dialog.
              </>
            ) : null}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel scrollFade={false}>
          <div className="space-y-3">
            <InputGroup>
              <InputGroupAddon align="inline-start">
                <SearchIcon />
              </InputGroupAddon>
              <Input
                ref={inputRef}
                placeholder="Search projects..."
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "ArrowDown") {
                    event.preventDefault();
                    moveActiveSelection(1);
                    return;
                  }
                  if (event.key === "ArrowUp") {
                    event.preventDefault();
                    moveActiveSelection(-1);
                    return;
                  }
                  if (event.key === "Enter" && activeResultProjectId) {
                    event.preventDefault();
                    void handleSelectProject(activeResultProjectId);
                  }
                }}
              />
            </InputGroup>

            <div className="max-h-64 space-y-1 overflow-y-auto">
              {filteredProjects.length === 0 ? (
                <p className="py-6 text-center text-sm text-muted-foreground">
                  {projects.length === 0
                    ? "No projects yet. Add one in the sidebar first."
                    : "No matching projects."}
                </p>
              ) : (
                filteredProjects.map((project) => {
                  const isActive = project.id === activeResultProjectId;
                  const isCurrentProject = project.id === activeProjectId;
                  return (
                    <button
                      key={project.id}
                      type="button"
                      className={cn(
                        "flex w-full cursor-pointer items-center gap-3 rounded-md border border-transparent px-3 py-2.5 text-left transition-colors hover:bg-accent",
                        isActive && "border-border/70 bg-accent text-accent-foreground",
                      )}
                      onClick={() => {
                        void handleSelectProject(project.id);
                      }}
                      onMouseEnter={() => {
                        setActiveResultProjectId(project.id);
                      }}
                    >
                      <ProjectFavicon cwd={project.cwd} />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="truncate text-sm font-medium">{project.name}</span>
                          {isCurrentProject ? (
                            <Badge variant="outline" size="sm">
                              Current
                            </Badge>
                          ) : null}
                        </div>
                        <p className="truncate text-xs text-muted-foreground">{project.cwd}</p>
                      </div>
                      <span
                        className={cn(
                          "hidden shrink-0 items-center gap-1 text-xs text-muted-foreground sm:inline-flex",
                          isActive && "text-foreground/70",
                        )}
                      >
                        <CornerDownLeftIcon className="size-3" />
                      </span>
                    </button>
                  );
                })
              )}
            </div>
          </div>
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
