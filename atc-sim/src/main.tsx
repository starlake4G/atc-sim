import { createRoot } from "react-dom/client";
import App from "./ui/App";
import "./styles.css";

const root = document.getElementById("root");
if (!root) throw new Error("找不到 #root");
createRoot(root).render(<App />);
