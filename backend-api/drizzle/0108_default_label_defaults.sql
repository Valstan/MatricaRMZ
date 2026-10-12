-- PR-5: строгая таблица вручную-выставленных дефолтов подписей (EAV-freeze с 2026-08-18)
-- Не EAV. Хранит id сотрудника, ФИО резолвится на чтении (employee таблица).
-- Глобальные значения (общие на всех), запись — админам (server-владение, как PPE-двери).
CREATE TABLE default_label_defaults (
  id SERIAL PRIMARY KEY,
  field_key VARCHAR(64) NOT NULL UNIQUE,
  employee_id INTEGER NOT NULL REFERENCES employees(id),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_default_label_key ON default_label_defaults(field_key);
