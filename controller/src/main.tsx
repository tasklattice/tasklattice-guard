import React from "react";
import ReactDOM from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { ThemeProvider } from "next-themes";
import { AuthProvider } from "@/lib/auth";
import { router } from "@/app-router";
import "@/i18n";
import "@/styles.css";

const queryClient = new QueryClient({ defaultOptions: { queries: { staleTime: 10_000, retry: 1 } } });
ReactDOM.createRoot(document.getElementById("root")!).render(<React.StrictMode><ThemeProvider attribute="class" defaultTheme="light" forcedTheme="light"><QueryClientProvider client={queryClient}><AuthProvider><RouterProvider router={router} /></AuthProvider></QueryClientProvider></ThemeProvider></React.StrictMode>);
