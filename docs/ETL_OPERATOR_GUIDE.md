# Nolte Geoservices UXO Target Platform — ETL Operator & Maintenance Guide

## Overview

The ETL pipeline coordinates data between source geodata tables (managed in QGIS/GIS workflows) and the live production application (`public.anomalies`, `public.feedback`).

This guide covers operational procedures, configuration validation, Web UI approvals, project-scoped runs, webhook notifications, and Slowly Changing Dimensions (SCD Type 2) audit history tracking.

---

## 1. Quick Reference & Core Commands

| Action | Command / Location | Privileges Required |
| :--- | :--- | :--- |
| **Trigger Full Run** | Web UI: `Database` icon &rarr; `Run Sync Now`<br>CLI: `docker compose --profile etl run --rm etl run --force` | Admin user (UI) / `etl_pipeline` (CLI) |
| **Trigger Single Project** | Web UI: Select project &rarr; `Run Sync Now`<br>CLI: `docker compose --profile etl run --rm etl run --force --project 11-26-5151` | Admin user (UI) / `etl_pipeline` (CLI) |
| **Validate Configuration** | `docker compose --profile etl run --rm etl validate-config` | Read-only |
| **Review Approvals (Web)** | Web UI: Click `Database` icon in navigation rail | Admin user (`etl_approver`) |
| **Review Approvals (CLI)** | `docker compose --profile etl run --rm etl-approve status --approver` | `etl_approver` |
| **Approve / Reject Staged** | `docker compose --profile etl run --rm etl-approve approve-change <ids...>`<br>`docker compose --profile etl run --rm etl-approve reject-change <ids...>` | `etl_approver` |
| **Approve / Reject Shift** | `docker compose --profile etl run --rm etl-approve approve-correction <pair_id>`<br>`docker compose --profile etl run --rm etl-approve reject-correction <pair_id>` | `etl_approver` |
| **Inspect Audit History** | Web UI: `Database` &rarr; `Audit History` tab<br>API: `GET /api/etl/history?limit=100` | Admin user (`etl_approver`) |

---

## 2. Configuration & Validation

The pipeline configuration is stored in `etl/config/projects.yml`.

### Configuration Linter
Before deploying or running after editing `projects.yml`, run the config linter:

```bash
docker compose --profile etl run --rm etl validate-config
```

The linter validates:
- **Global Settings**: Validates `correction_radius_m` is positive.
- **Projects**: Verifies project IDs follow the `YY-NN-NNNN` pattern, schemas exist, and SRID is a valid positive integer (e.g., 25832, 25833).
- **Sources**: Verifies table names, instruments (`magnetic`, `georadar`), and coordinate column definitions (`easting`, `northing`).
- **Data Types & Bounds**: Verifies coordinate columns in Postgres are numeric/float types and fall within valid UTM boundaries.

---

## 3. Web Approver & Runner Interface

Admins can manage the entire ETL lifecycle from the web application without using command-line tools:

1. **Access**: Click the `Database` icon in the left-hand navigation rail. A badge shows pending approvals in real-time.
2. **Top Ribbon**: Displays the status of the last run, duration, and counts of pending staged changes and coordinate shifts.
3. **Execution Bar**:
   - **Project Selector**: Run across all projects or select a specific project (`11-26-5151`, `11-24-2736`).
   - **Force Sync Toggle**: Bypasses the fingerprint cache to immediately apply decisions.
   - **Run Sync Now**: Triggers an execution in the background and refreshes the panel once finished.
4. **Staged Changes Tab**:
   - Shows attribute differences (`category`, `layer`, `evaluated_depth`, `instrument`).
   - Select individual rows or use "Select All" for bulk approve/reject.
5. **Coordinate Corrections Tab**:
   - Compares existing coordinates with new source coordinates.
   - Displays spatial shift distance in meters and rule match rationale (`source_key` vs spatial proximity).
6. **Runs & Health Tab**:
   - Inspect the last 10 pipeline executions with duration, exit status, and detailed metrics (rows written, rows staged).
7. **Audit History (SCD Type 2) Tab**:
   - Inspect full historical timeline of all changes made to targets.
   - Search by Target ID, VM Number, Project, or Change Reason.

---

## 4. Slowly Changing Dimensions (SCD Type 2) Audit History

Target history is maintained in `public.anomaly_history` through the PostgreSQL trigger `trigger_anomaly_scd_audit`.

### Lifecycle:
1. **Creation**: When a new anomaly is inserted, an initial record is created with `is_current = true`, `valid_from = now()`, and `valid_to = NULL`.
2. **Modifications**: When attributes or coordinates change:
   - The prior active record is closed (`valid_to = now()`, `is_current = false`).
   - A new current record is inserted (`valid_from = now()`, `valid_to = NULL`, `is_current = true`).
   - The change reason is tagged automatically (`etl_change`, `etl_correction`, `field_sync`, `initial`).
   - If applied via ETL approver, the associated `decision_id` is recorded.
3. **Integrity**: A partial unique index `(anomaly_id) WHERE is_current = true` enforces at most one current record per target at the database engine level.

---

## 5. Webhook Notifications

Set `ETL_ALERT_WEBHOOK_URL` in `.env` to enable automated alerts:
- **Slack / Teams / Discord / Generic HTTP**: Posts JSON notifications automatically.
- **Alert Events**:
  - `FAILED`: Triggered on unhandled errors or safety gate failures with traceback.
  - `PENDING`: Triggered when a run holds back changes or shifts awaiting human review.
  - `SUCCESS`: Triggered on successful merges summarizing written and staged row counts.

---

## 6. Security & Privilege Separation

- `etl_pipeline`: Runs the pipeline. Possesses `INSERT` and `SELECT` on targets, but **never** `UPDATE` or `DELETE` on `public.anomalies`. It executes changes exclusively via PostgreSQL `SECURITY DEFINER` functions in `etl_admin`.
- `etl_approver`: Used exclusively for reviewing and deciding staged changes and coordinate shifts. It cannot write directly to `public.anomalies`.
- All decisions require explicit human review before modifying production records.
