# The ETL runner: dbt + the Python runner in one small image. Built and started only
# through the "etl" compose profile; see etl/README.md.
FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 DBT_SEND_ANONYMOUS_USAGE_STATS=False

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY config ./config
COPY dbt ./dbt
COPY runner ./runner
RUN useradd --create-home etl && chown -R etl /app
USER etl

ENTRYPOINT ["python", "runner/run.py"]
CMD ["loop"]
