export type Source = {
	id: string;
	name: string;
	link: string;
};

export const SOURCES: Source[] = [
	{
		id: "production",
		name: "production 🍎",
		link: "https://app.microboard.io/api/v1/dashboard",
	},
	{
		id: "development",
		name: "development 🍏",
		link: "https://dev-app.microboard.io/api/v1/dashboard",
	},
];
