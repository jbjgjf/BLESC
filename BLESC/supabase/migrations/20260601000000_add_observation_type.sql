-- Migration to add observation_type to entries table
ALTER TABLE public.entries ADD COLUMN observation_type text NOT NULL DEFAULT 'daily';
