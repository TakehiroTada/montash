import { useEffect, useRef } from "react";
import { createRoot } from "react-dom/client";

function Timeline() {
	const ref = useRef<HTMLCanvasElement>(null);
	useEffect(() => {
		const c = ref.current!.getContext("2d")!;
		c.fillRect(0, 0, 10, 10);
	}, []);
	return <canvas ref={ref} width={100} height={20} />;
}
createRoot(document.getElementById("root")!).render(
	<div>
		<h1>vedit</h1>
		<Timeline />
	</div>,
);
