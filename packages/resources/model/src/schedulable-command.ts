/*
 * Copyright 2026 CodeMatters, Lda.
 *
 * Licensed under the Apache License, Version 2.0 (the "License"); you may not use this file
 * except in compliance with the License. You may obtain a copy of the License at
 *
 * https://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software distributed under
 * the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND,
 * either express or implied. See the License for the specific language governing permissions
 * and limitations under the License.
 */

/**
 * A command whose sending can be postponed.
 *
 * Instead of posting such a command now, plan it with the scheduler — post
 * `ScheduleCommand` with the command and its due time — and the scheduler sends
 * it once that time arrives.
 */
// A marker: what makes a command schedulable is declaring it so, not any field.
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface SchedulableCommand {}
