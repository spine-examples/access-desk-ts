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

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider } from "react-router/dom";
import { AppRouter } from "./app/router.js";
import { Config } from "./config.js";
import { Session } from "./session/session.js";
import "./styles/global.css";

const root = document.getElementById("root");
if (root === null) {
  throw new Error("The page has no place to show the application.");
}
try {
  await Config.load();
} catch (error) {
  root.textContent = "The page cannot start: it does not know where the application is.";
  throw error;
}
const router = AppRouter.create();
createRoot(root).render(
  <StrictMode>
    <Session.Provider>
      <RouterProvider router={router} />
    </Session.Provider>
  </StrictMode>,
);
