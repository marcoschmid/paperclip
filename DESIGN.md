---
version: alpha
name: Paperclip
description: Operational company-layer UI for agents, issues, approvals, budgets and execution traces.
colors:
  background: "#FFFFFF"
  backgroundDark: "#252525"
  surface: "#FFFFFF"
  surfaceDark: "#343434"
  text: "#252525"
  textDark: "#F7F7F7"
  muted: "#737373"
  border: "#E5E5E5"
  primary: "#252525"
  primaryDark: "#F7F7F7"
  success: "#16A34A"
  warning: "#D97706"
  danger: "#DC2626"
  info: "#2563EB"
typography:
  display:
    fontFamily: Inter
    fontSize: 36px
    fontWeight: 650
    lineHeight: 1.1
    letterSpacing: "0px"
  heading:
    fontFamily: Inter
    fontSize: 22px
    fontWeight: 600
    lineHeight: 1.25
    letterSpacing: "0px"
  body:
    fontFamily: Inter
    fontSize: 16px
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: "0px"
  label:
    fontFamily: Inter
    fontSize: 12px
    fontWeight: 600
    lineHeight: 1.2
    letterSpacing: "0px"
rounded:
  sm: 6px
  md: 8px
  lg: 12px
  full: 999px
spacing:
  xs: 4px
  sm: 8px
  md: 16px
  lg: 24px
  xl: 40px
components:
  issue-row:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    rounded: "{rounded.md}"
  primary-action:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.surface}"
    rounded: "{rounded.md}"
---

# Paperclip Design System

## Overview

Paperclip should feel like a serious operating console for autonomous work: calm, auditable, dense enough for repeated use and explicit about who owns the next action.

## Colors

Use neutral black-white precision with semantic status colors. Avoid decorative accent gradients. Status color always means state, risk or budget pressure.

## Typography

Use Inter with pragmatic hierarchy. Dense tables and event logs need readable body text, clear labels and tabular numeric treatment for cost and usage.

## Layout

Prefer lists, timelines, strips and dossiers over large card grids. Company, project, issue and agent pages should make ownership, status, blockers and next action visible in the first viewport.

## Elevation & Depth

Keep depth quiet: one border, subtle shadow, clear focus ring. Dark mode uses surface steps rather than glow.

## Shapes

Radius stays restrained: 8px for most controls, 12px for larger panels, pill chips only for status and filters.

## Components

Issue rows need identifier, title, owner, status, blockers and last activity. Approval components must separate request, risk and decision. Budget cards must show current state and threshold context.

## Do's and Don'ts

Do make execution state auditable. Do surface blockers explicitly. Do keep technical traces accessible but not dominant. Do not bury ownership, use vague CTA copy or style Paperclip like a marketing page.

## Agent Prompt Guide

Design operational pages with compact hierarchy, strong ownership cues, neutral surfaces and explicit decision states.

## Screen Contracts

- Issues: scan, filter, understand owner and next step.
- Agents: show capability, budget, run health and current work.
- Approvals: decide with risks and consequences visible.
- Costs: compare budget, provider usage and trend.

## Source References

- `/Users/marco/Code/paperclip/ui/src/index.css`
- `/Users/marco/.openclaw/workspace/projects/paperclip/PROJECT.md`
