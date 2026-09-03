FROM python:3.12-slim

WORKDIR /app

RUN pip install --no-cache-dir uv

COPY pyproject.toml uv.lock ./
COPY requirements-market-data.txt ./

RUN uv sync --frozen
RUN uv pip install -r requirements-market-data.txt

COPY apps/api ./apps/api

ENV PYTHONUNBUFFERED=1
ENV PORT=8000

EXPOSE 8000

CMD ["uv", "run", "uvicorn", "--factory", "app.main:create_app", "--app-dir", "apps/api", "--host", "0.0.0.0", "--port", "8000"]
